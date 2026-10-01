import { builtinEnvironments, type Environment } from 'vitest/runtime'

// 自定义 Vue host renderer 在 Node 中运行，但 SFC 必须编译为客户端 render。
export default {
  ...builtinEnvironments.node,
  name: 'vue-client',
  viteEnvironment: 'client'
} satisfies Environment
