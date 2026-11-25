# 参与开发

## 跑测试

```bash
pnpm install --prod=false
node test/run-all.mjs          # 主入口 + 启动冒烟
node test/install/fresh-env.mjs # 空环境能跑
```

## 代码风格

- **ESM**（`.js` + `export`），不用 CommonJS
- 文件头写清「为什么要有这个文件」，不是「这个文件做什么」
- 不写没用的注释，但**踩过的坑一定要写**（下次有人会再踩）

## 改代码改哪个目录（重要）

本仓库 `src/` 与 `lib/` **不是自动化构建关系**：

- **运行时只读 `lib/*.js`**。改 `lib/` 里的 `.js` 立即生效（重启 DSH）。
- `src/*.ts` 是**人格模块的 TypeScript 迁移蓝图**（迁移进行中），**没有 tsconfig、没有 build 脚本、没有 typescript 依赖**——历史上从未配置过自动化编译。
- 所以**改 `lib/*.js` 就是改代码本身**，不要指望「改 src 再编译」。若改了 `src/*.ts`，需要你手工把改动同步回 `lib/*.js`（两处结构不一定一一对应，`src` 比 `lib` 更完整）。

> 一句话：**以 `lib/*.js` 为真相**；`src/*.ts` 是留给后续「补完 TS 迁移」用的蓝图，当前不参与运行、不参与发布。

## 提 PR

1. 一个 PR 只做一件事
2. 改了行为就加测试
3. 如果改了配置字段，**同步改 `lib/persona/config.js` 和 `lib/memory/config.js` 两处**（schema + resolveConfig）

## 不要做的事

- 不要往 `dist/` 或 `node_modules/` 里改东西（升级就丢）
- 不要引入需要编译的依赖（Android 上装不动）
- 不要加出网请求
