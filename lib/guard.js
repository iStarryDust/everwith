/**
 * 宿主自带的那道门。
 *
 * DSH 的 Host Connection 服务上有 `requestRejection(request)`：
 *   - 403   Host / Origin 不对（比如别的网页发过来的请求）
 *   - 401   没有登录态
 *   - 无值  放行
 *
 * 插件的路由是直接注册在裸 webServer 上的，不经过这道门 —— 所以自己补一层。
 * 拿不到 connection 服务（旧版本宿主）就放行：不能因为宿主版本把插件弄挂。
 */

/** 造一个请求门：传入 request，返回该拒绝的状态码，放行返回 0。 */
export function makeRequestGate(ctx) {
  return (request) => {
    let connection
    try {
      connection = ctx?.get?.('connection')
    } catch {
      return 0
    }
    const gate = connection?.requestRejection
    if (typeof gate !== 'function') return 0
    try {
      return gate.call(connection, request) || 0
    } catch {
      return 0
    }
  }
}

/**
 * 把一条路由的 handler 包一层访问检查。
 * 别的字段（method / path / kind）原样保留。
 */
export function guardRoute(route, reject) {
  const handler = route?.handler
  if (!route || typeof handler !== 'function') return route
  return {
    ...route,
    handler: async (req, res) => {
      const code = reject?.(req) || 0
      if (code) {
        try {
          res.statusCode = code
          res.setHeader('content-type', 'text/plain; charset=utf-8')
          res.end(code === 401 ? '需要登录' : '拒绝访问')
        } catch {
          /* ignore */
        }
        return
      }
      return handler(req, res)
    },
  }
}
