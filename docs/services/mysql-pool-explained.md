# NovaChat MySQL 连接池详解（教学版）

> 基于 `services/common/src/mysql_pool.cpp` 和 `services/common/include/nova/mysql_pool.h` 的逐段讲解。
> 目标：理解 `MySqlPool` 的架构、`this` 的用法、以及 `WorkerThread` 每一行代码的意图。
> 阅读本文前建议先了解：`std::thread`、互斥锁（mutex）、条件变量（condition_variable）的基础概念。

---

## 目录

1. [大局：为什么需要 WorkerThread](#1-大局为什么需要-workerthread)
2. [`this` 是什么](#2-this-是什么)
3. [成员函数为什么不能独立存在](#3-成员函数为什么不能独立存在)
4. [`this` 和对象的对应关系](#4-this-和对象的对应关系)
5. [`Init` 中的线程启动](#5-init-中的线程启动)
6. [`WorkerThread` 逐段拆解](#6-workerthread-逐段拆解)
7. [一次完整请求的生命周期](#7-一次完整请求的生命周期)
8. [设计要点总结](#8-设计要点总结)

---

## 1. 大局：为什么需要 WorkerThread

先看头文件注释里的核心矛盾（`mysql_pool.h:7-12`）：

> - bthread 是用户态协程，`mysql_real_query()` 是**同步阻塞**调用
> - 如果在 bthread 里直接调用，会阻塞整个 pthread（影响同线程上的所有 bthread）

业务代码跑在 bthread（协程）里，而 MySQL 的 C API 一调用就会"卡住等网络"。协程卡住等于整条 pthread 都卡住，会拖垮所有共享这条 pthread 的协程。

**解决思路：** 让阻塞的 MySQL 调用由专用的普通线程（pthread）去干。bthread 把任务丢进队列后自己挂起，pthread 干完活再唤醒它。`WorkerThread` 就是这些专用 pthread 干的活。

```
bthread (业务)                     Worker pthread                 MySQL
    │ 提交任务到队列                  │                             │
    │ done.wait() 挂起自己           │ 从队列取任务                 │
    │                               │── mysql_real_query() ──────→│
    │                               │←──────── 结果 ──────────────│
    │ ←── done.signal() 唤醒 ───────│ 写回结果                     │
    │ 拿到结果继续执行               │                             │
```

---

## 2. `this` 是什么

从一个最简单的类说起：

```cpp
class Dog {
public:
    void bark() {
        std::cout << name << std::endl;  // name 是哪来的?
    }
private:
    std::string name = "旺财";
};

Dog d1;
Dog d2;
d1.bark();   // 打印的是 d1 的 name 还是 d2 的?
d2.bark();
```

`bark()` 里写的 `name`，打印谁的值，**取决于这次调用是在哪个对象上进行的**。编译器的秘密是：**每个成员函数都有一个隐藏参数，指向"调用它的那个对象"。这个隐藏参数就是 `this`。**

```cpp
// 你写的代码:
void bark() {
    std::cout << name;
}

// 编译器实际看到的东西(示意):
void bark(Dog* this) {                // 隐藏参数!
    std::cout << this->name;          // name 其实是 this->name
}

d1.bark();   // 编译成: bark(&d1) → 函数里 this == &d1
d2.bark();   // 编译成: bark(&d2) → 函数里 this == &d2
```

**`this` 就是一个普通指针**，指向当前对象。同一份代码，`this` 不同，操作的对象就不同。平时编译器自动帮你传这个参数，你感觉不到它；但 `std::thread` 没法替你猜对象，所以必须亲手把它写出来。

---

## 3. 成员函数为什么不能独立存在

### 3.1 心智模型：代码只有一份，数据每个对象一份

`bark()` 的机器码在内存里**只有一份**——无论创建多少个 `Dog` 对象，函数代码都不会复制。对象只是**一块装数据的内存**：

```
代码区(只有一份):          对象区(每个对象一块):
┌──────────────────┐      ┌──────────────┐
│ bark() 的机器码  │      │ d1: "旺财"   │
└──────────────────┘      ├──────────────┤
                          │ d2: "来福"   │
                          └──────────────┘
```

### 3.2 矛盾与解决方案

- `bark()` 的代码只有一份，但代码里引用了 `name`
- 而 `name` 在每个对象里各有一份

当那一份代码运行时，它怎么知道读哪个对象的 `name`？**它不知道，除非有人告诉它。** 这就是成员函数不能独立存在的根本原因：

> 成员函数的代码引用了"对象的数据"，而代码本身不含任何对象。光有代码，它连读哪个成员都不知道，更别说执行了。

C++ 的解决方案：**每次调用成员函数时，强制把"对象在哪"（`this`）作为参数传进去。**

### 3.3 对比普通函数

```cpp
int add(int a, int b) { return a + b; }
```

这个函数要用的所有东西都**明明白白写在参数列表里**，`&add` 这个地址就是完整的信息，可以直接调用。

而 `&MySqlPool::WorkerThread` 呢？函数体里用了 `running_`、`task_queue_`、`connections_`……这些东西**一个都不在参数列表里**，全部住在某个对象里：

```
&add                       → 完整,可以直接调用
&MySqlPool::WorkerThread   → 残缺,缺一个"在哪个对象上执行"
```

打个比方：成员函数像一份菜谱，写着"打开**你自己的**冰箱拿鸡蛋"。菜谱只有一份，但每个厨房都有自己的冰箱。光拿菜谱没用——还得说清楚去**哪个厨房**做菜。

所以准确的说法是：成员函数**可以**被取地址、被存储（这就是"成员函数指针"），但**光凭这个地址无法完成一次调用**——必须补上一个对象，才凑齐一次完整的调用。

---

## 4. `this` 和对象的对应关系

对应关系就一句话：

> **在对象 `obj` 上调用成员函数时，`this` 就等于 `&obj`。函数内部访问的任何成员 `x`，实际上都是 `this->x`。**

它不是魔法，就是一个普通的 `MySqlPool*` 指针。看 `WorkerThread` 里的每一行（`mysql_pool.cpp:137`）：

```cpp
void MySqlPool::WorkerThread(int worker_id) {
    while (running_) {              // 其实是 this->running_
        ...
        queue_cv_.wait(lock, [this] { ... });   // this->queue_cv_
        MYSQL* conn = AcquireConnection();      // this->AcquireConnection()
    }
}
```

这些 `running_`、`queue_cv_` 是**谁的**，完全取决于这次调用传进来的 `this` 指向谁。

### 实战验证：两个连接池

```cpp
MySqlPool poolA;
MySqlPool poolB;
poolA.Init("127.0.0.1", 3306, ..., 4);   // A 池
poolB.Init("127.0.0.1", 3306, ..., 8);   // B 池
```

`poolA.Init(...)` 时，编译器自动传了 `&poolA`，所以 Init 函数里的 `this == &poolA`，启动的 4 个线程全部绑定到 poolA 的数据上；`poolB` 同理。**A 池的 4 个线程和 B 池的 8 个线程运行的是同一份 `WorkerThread` 机器码，但永远不会互相搞混队列和连接**——因为它们的 `this` 指向不同的对象。

---

## 5. `Init` 中的线程启动

`mysql_pool.cpp:95-97`：

```cpp
// 2. 启动pool_size个 std::thread(pthread) WorkerThread
for (int i = 0; i < pool_size; i++) {
    workers_.emplace_back(&MySqlPool::WorkerThread, this, i);
}
```

`workers_` 是 `std::vector<std::thread>`（`mysql_pool.h:101`），`emplace_back` 在 vector 尾部就地构造一个 `std::thread`。三个参数回答了 `std::thread` 的三个问题：

| 参数 | 含义 |
|------|------|
| `&MySqlPool::WorkerThread` | 新线程要**运行哪个函数** |
| `this` | 这个函数要**在哪个对象上**调用 |
| `i` | 调用时传什么**实参**（即 `worker_id`） |

每个新线程实际执行的就是 `this->WorkerThread(i)`。等价写法：

```cpp
workers_.emplace_back([this, i]() { WorkerThread(i); });
```

### 生命周期注意事项

线程里存的是**裸指针** `this`，不是拷贝。线程存活期间，`MySqlPool` 对象**必须还活着**，否则线程访问成员就是访问已销毁的内存（悬垂指针）。析构函数（`mysql_pool.cpp:30`）处理了这个约定：

```cpp
MySqlPool::~MySqlPool() {
    running_ = false;        // 1. 发"下班"信号
    queue_cv_.notify_all();  // 2. 唤醒所有睡眠中的工作线程
    conn_cv_.notify_all();

    for (auto& w : workers_) {
        if (w.joinable()) w.join();   // 3. 等所有线程退出后再销毁
    }
    // 4. 最后才关闭连接
}
```

这就是为什么拷贝构造/赋值被 `delete` 了（`mysql_pool.h:45-46`）——对象被拷贝走的话，副本销毁时原对象的线程全完蛋。

---

## 6. `WorkerThread` 逐段拆解

完整代码见 `mysql_pool.cpp:137-217`。

### 6.1 循环外壳

```cpp
void MySqlPool::WorkerThread(int worker_id) {
    (void)worker_id;          // ① 暂时用不到编号,消除"未使用参数"警告

    while (running_) {        // ② 只要池还在运行,就不断接任务
        ...
    }
}
```

② `running_` 是 `std::atomic<bool>`（`mysql_pool.h:102`）。必须用 atomic，因为**多个工作线程同时读、析构函数写**，普通 bool 跨线程读写是未定义行为。析构时置 false 就是给所有工作线程发"下班"信号。

### 6.2 等任务 —— 生产者/消费者模型

```cpp
Task task;
{
    std::unique_lock<std::mutex> lock(queue_mu_);   // ③
    queue_cv_.wait(lock, [this] {                   // ④
        return !task_queue_.empty() || !running_;
    });
    if (!running_ && task_queue_.empty()) break;    // ⑤
    task = std::move(task_queue_.front());          // ⑥
    task_queue_.pop();
}
```

- **生产者**：bthread 调 `Execute`/`Query`/`QueryAll`，把 `Task` 推进 `task_queue_`，然后 `notify_one()` 叫醒一个工人
- **消费者**：`WorkerThread`，即这一段

**③ 为什么要加锁？** `task_queue_` 是共享数据，多个工人线程同时取任务必须互斥访问。`std::unique_lock` 是 RAII 锁，构造时加锁，离开作用域自动解锁。

**④ 条件变量 wait 的"谓词"形式。** 做的事情是：**原子地**解锁 + 挂起线程，直到有人 `notify` **并且** 谓词为 true。

- 两个唤醒条件：`!task_queue_.empty()`（有任务来了）或 `!running_`（池要关闭了）
- 为什么必须写成带谓词的形式？因为存在**虚假唤醒**（线程可能没被 notify 就醒了），而且"解锁→睡觉"和"检查→notify"之间可能丢失信号。谓词形式会循环检查："醒来 → 看条件 → 不满足就继续睡"，保证逻辑正确

**⑤ 优雅退出。** 如果 wait 返回是因为 `!running_`（关闭信号）而队列又空了 → `break` 退出循环。注意这个判断很讲究：**如果队列里还有活，即使收到关闭信号也会先干完**——排空队列再下班。

**⑥ 用 `std::move` 搬任务。** `Task` 里有 `std::string`、`std::function`，直接赋值是深拷贝。move 后源对象变"空壳"，再 `pop()` 扔掉，全程零拷贝。

**⑦ 这个 `{}` 作用域非常重要**：离开作用域锁立刻释放。也就是说，工人拿到任务后马上解锁，后面的 MySQL 查询（可能要几百毫秒）是在**不加锁**的情况下执行的，其他工人可以并行取任务。如果锁一直持有到函数末尾，所有工人就会串行化，连接池就废了。

### 6.3 拿连接 + 执行 SQL

```cpp
MYSQL* conn = AcquireConnection();                 // ⑧

int rc = mysql_real_query(conn, task.sql.c_str(), task.sql.size());  // ⑨
```

**⑧ `AcquireConnection()`**（`mysql_pool.cpp:106`）：从 `connections_` 里找一个空闲连接，标记 `in_use = true`，没有空闲就阻塞等待。

这里有个可以思考的点：池子里**连接数 = 工人数**（都是 `pool_size`），每个工人同时最多占用一个连接，所以实际上永远有空闲连接、几乎不会阻塞。那为什么还要写这套逻辑？因为它把"每个工人专用一个连接"改成"工人和连接解耦"——如果哪天想改成连接数 ≠ 工人数，这套代码不用动。这是设计上的灵活性。

**⑨ 这一行是整个文件存在的理由。** `mysql_real_query` 会阻塞直到 MySQL 服务器返回。这个阻塞发生在专用 pthread 上，**不碰 bthread 的调度**，其他 bthread 照常运行。

### 6.4 处理结果 —— 三路分支

```cpp
if (rc != 0) {
    // 分支一:查询失败
    *task.result = butil::Status(-1,
        std::string("MySQL error: ") + mysql_error(conn));
}
else if (task.is_query) {
    // 分支二:SELECT,需要读取结果集
    ...
}
else {
    // 分支三:INSERT/UPDATE/DELETE,直接成功
    *task.result = butil::Status::OK();
}
```

- **分支一**：`mysql_real_query` 返回非 0 表示失败，把 `mysql_error(conn)` 的错误文本包装成 `butil::Status(-1, ...)` 写回
- **分支三**：写操作执行成功即完成，直接写 `OK`

**分支二**（SELECT）多了一步：数据还在服务器端，必须取回来：

```cpp
MYSQL_RES* res = mysql_store_result(conn);   // 一次性把整个结果集拉回内存
int ncols = mysql_num_fields(res);           // 有几列
MYSQL_FIELD* fields = mysql_fetch_fields(res); // 列信息

std::vector<std::string> col_names;
for (int i = 0; i < ncols; i++) {
    col_names.push_back(fields[i].name);     // 收集列名: id, name, email...
}
```

然后根据任务类型，用两种方式消费每一行：

```cpp
if (task.rows) {
    // 方式 A: QueryAll —— 全部行收进 vector
    MYSQL_ROW row;
    while ((row = mysql_fetch_row(res))) {      // 循环取行,NULL 表示取完
        Row r;                                   // Row = std::map<std::string, std::string>
        for (int i = 0; i < ncols; i++) {
            r[col_names[i]] = row[i] ? row[i] : "";   // ⑩
        }
        task.rows->push_back(std::move(r));
    }
}
else if (task.row_cb && task.cb_mutex) {
    // 方式 B: Query —— 每行调一次回调(流式,内存友好)
    while ((row = mysql_fetch_row(res))) {
        Row r;
        ...
        {
            std::lock_guard<std::mutex> cb_lock(*task.cb_mutex);  // ⑪
            (*task.row_cb)(r);
        }
    }
}

mysql_free_result(res);    // ⑫ 释放结果集内存
```

- **⑩ `row[i] ? row[i] : ""`**：MySQL 里 `NULL` 字段对应的 C 指针是 `nullptr`，直接用它构造 `std::string` 会崩溃，所以把 NULL 统一转成空字符串
- **⑪ 回调为什么要加锁？** 回调执行在**工人线程**里，而结果要写进的容器可能被 bthread 侧的其他协程并发访问，所以需要外部传入的锁（`task.cb_mutex`）保护
- **⑫** 结果集占的内存是 MySQL 客户端库分配的，用完必须手动释放，否则每次查询泄漏一块内存

### 6.5 收尾 —— 还连接、唤醒 bthread

```cpp
ReleaseConnection(conn);   // ⑬ 标记连接空闲,notify 等待者
task.done->signal();       // ⑭ 唤醒挂起的 bthread
```

**⑬** 把连接放回池子（`in_use = false` 并 `notify_one`），下一个任务可以继续用。

**⑭ 这是整个闭环的最后一块拼图。** 回想 bthread 那一侧（以 `Execute` 为例，`mysql_pool.cpp:221`）：

```cpp
butil::Status MySqlPool::Execute(const std::string& sql) {
    butil::Status result;
    bthread::CountdownEvent done(1);
    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, false, &result, &done, ...});  // 投递任务
    }
    queue_cv_.notify_one();   // 叫醒一个工人
    done.wait();              // ← bthread 挂起自己,释放 pthread
    return result;            // 被唤醒后,result 已被工人写好
}
```

- bthread 投完任务就 `done.wait()` **挂起**——关键：挂起的是协程，底层 pthread 被释放去跑别的 bthread，没有任何线程在空转等待
- 工人干完活，`done.signal()` 唤醒这个 bthread
- bthread 醒来继续执行 `return result`，此时 `result` 已经被工人写好了

**bthread 的"等"不是阻塞，是让出 CPU；工人的"等"是真正的阻塞，但发生在专用的 pthread 上。** 双方各司其职，这就是这套设计的精髓。

---

## 7. 一次完整请求的生命周期

以 `QueryAll` 为例：

```
1. 业务 bthread 调 pool.QueryAll("SELECT * FROM users", &rows)
2. 构造 Task{...}, push 进 task_queue_, notify_one()
3. bthread 执行 done.wait() → 挂起自己,释放 pthread
4. 某个 WorkerThread 被唤醒:
   - 加锁 → 检查队列非空 → move 出任务 → 解锁
   - AcquireConnection() 拿一个空闲连接
   - mysql_real_query() 阻塞执行 SQL   ← 唯一真正阻塞的地方
   - 逐行解析结果,写进 task.rows
   - ReleaseConnection() 还连接
   - task.done->signal() 唤醒第 3 步的 bthread
5. bthread 醒来,return result,业务代码拿到 rows
6. WorkerThread 回到 while 循环顶部,继续等下一个任务
```

---

## 8. 设计要点总结

| 代码 | 为什么这样写 |
|------|-------------|
| `while (running_)` + `atomic<bool>` | 多线程读、析构写，需要原子操作保证安全 |
| 条件变量的谓词形式 | 防止虚假唤醒和信号丢失 |
| 取任务的 `{}` 作用域 | 锁只保护队列操作，慢速 SQL 不加锁执行，工人并行 |
| `std::move` 搬任务 | Task 含 string/function，避免深拷贝 |
| 阻塞的 `mysql_real_query` | 在专用 pthread 上阻塞，不影响 bthread 调度 |
| `done.signal()` | 完成协程 ↔ 线程的握手，唤醒挂起的 bthread |
| 析构先 join 再关连接 | 保证线程不会访问已销毁的对象（裸 `this` 的生命周期约定） |
| 拷贝构造/赋值 `delete` | 防止对象被拷贝导致线程悬垂 |

---

## 延伸阅读

- 总览文档：[`mysql-pool.md`](mysql-pool.md) —— 连接池的技术职责、业务角色、系统连接
- 相关设计：`docs/services/common.md`、`docs/services/logger.md`
