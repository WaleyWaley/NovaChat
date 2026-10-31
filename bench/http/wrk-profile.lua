-- 查资料接口压测: 受保护接口, 带 JWT (TOKEN 由 run-http.sh 注入环境变量)
-- URL 由命令行指定 (GET /api/users/<user_id>)
wrk.method = "GET"
wrk.headers["Authorization"] = "Bearer " .. os.getenv("TOKEN")
