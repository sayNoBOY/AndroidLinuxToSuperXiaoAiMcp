// zh-CN 聚合入口：按分片合并（base/login/home/service/oplog…）
// 新增分片在此 import + 展开；分片内部按 key 前缀路由，见附录-字符串盘点.md
import base from './zh-CN/base.js'
import login from './zh-CN/login.js'
import blank from './zh-CN/blank.js'
import home from './zh-CN/home.js'
import service from './zh-CN/service.js'
import oplog from './zh-CN/oplog.js'

export default {
  ...base,
  ...login,
  ...blank,
  ...home,
  ...service,
  ...oplog,
}
