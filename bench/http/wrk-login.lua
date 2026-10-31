-- 登录接口压测: 固定用户反复登录 (SELECT + PBKDF2-SHA256 验证路径)
-- 前置: run-http.sh 会确保 bench_login 用户存在
wrk.method = "POST"
wrk.body = '{"username":"bench_login","password":"bench123456","device_type":"web","device_name":"wrk"}'
wrk.headers["Content-Type"] = "application/json"
