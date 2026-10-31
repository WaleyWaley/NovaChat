-- 注册接口压测: 每个请求一个全新用户名 (真实走完校验+查重+INSERT 全链路)
-- 注意: 每个请求都会往 users 表写一行, 压测完数据会残留 (可手工清理)
local counter = 0
local base = os.time() % 1000000

request = function()
  counter = counter + 1
  local body = string.format(
    '{"username":"wrk_%d_%d","password":"bench123456","first_name":"wrk"}',
    base, counter)
  wrk.body = body
  wrk.headers["Content-Type"] = "application/json"
  return wrk.format("POST", "/api/auth/register")
end
