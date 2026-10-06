// en-US 聚合入口：按分片合并（与 zh-CN 分片一一对应，i18n-check 校验 key 对齐）
import base from './en-US/base.js'
import login from './en-US/login.js'
import blank from './en-US/blank.js'
import home from './en-US/home.js'
import service from './en-US/service.js'
import oplog from './en-US/oplog.js'

export default {
  ...base,
  ...login,
  ...blank,
  ...home,
  ...service,
  ...oplog,
}
