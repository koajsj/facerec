# 人脸追踪网页项目

这是一个纯前端人脸追踪网页，基于 MediaPipe Tasks Vision 在浏览器本地运行，不需要后端服务。当前版本重点优化了移动端界面、人脸框跟随速度、稳定性和交互质量。

## 目录结构

- `shared-src`：共享源代码，所有功能修改优先改这里
- `local-dev`：本地运行版本，由同步脚本生成
- `gh-pages`：GitHub Pages 发布版本，由同步脚本生成，也是 Git 仓库
- `scripts/sync.ps1`：将 `shared-src` 同步到 `local-dev` 和 `gh-pages`

## 当前功能

- 摄像头实时人脸追踪
- 绿色人脸框，无关键点散点干扰
- 自适应人脸框覆盖范围，更接近完整脸部
- 快速、均衡、稳定三种模式
- 检测灵敏度、跟随速度和镜像预览可调
- 状态、置信度、画面质量和事件提示
- 支持眨眼、张嘴、偏头等轻量事件显示
- 手机端竖屏优先布局，按钮触控面积更大

## 算法优化

- 使用 MediaPipe Face Landmarker 作为识别核心
- IoU + 中心距离进行跟踪关联，降低框跳动
- 根据移动幅度、脸部尺寸和置信度动态调整平滑系数
- 对快速移动加入轻量速度预测，降低跟随延迟
- 按脸部占画面比例自适应扩大识别框
- 对低置信、过小人脸进行过滤，减少误框
- 状态面板低频刷新，降低 UI 更新开销

## 界面说明

主界面保留三个主要操作：

- `开始/停止`：启动或关闭摄像头追踪
- `均衡/快速/稳定`：切换跟随策略
- `工具`：展开灵敏度、跟随速度和镜像设置

手机端会将相机区域放在首屏核心位置，控制区和状态区自动下移，便于单手操作和阅读。

## 本地运行

```powershell
cd C:\Users\Administrator\Desktop\github\face-tracker
powershell -ExecutionPolicy Bypass -File .\scripts\sync.ps1

cd C:\Users\Administrator\Desktop\github\face-tracker\local-dev
py -m http.server 5600
```

浏览器打开：

```text
http://localhost:5600
```

摄像头权限要求页面运行在 `localhost` 或 HTTPS 环境。

## 发布说明

GitHub Pages 发布目录是：

```text
gh-pages/
```

发布前应执行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\sync.ps1
node --check .\shared-src\app.js
node --check .\shared-src\face-algorithm.js
```

并检查：

- `shared-src`、`local-dev`、`gh-pages` 中核心文件已同步
- `gh-pages` 工作区没有遗漏修改
- 页面中文无乱码
- 手机端按钮、状态文字和人脸框不遮挡

## GitHub Pages

- 仓库：https://github.com/koajsj/facerec
- 访问地址：https://koajsj.github.io/facerec/
