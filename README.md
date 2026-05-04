# 人脸识别项目（双版本 + 高价值增强）

## 目录结构

- `shared-src`：共享源码（主维护目录）
- `local-dev`：本地运行版本
- `gh-pages`：GitHub Pages 发布版本
- `scripts/sync.ps1`：同步脚本（将 shared-src 同步到 local-dev/gh-pages）

## 核心文件

- `shared-src/face-algorithm.js`：算法文件（独立可查阅）
- `shared-src/app.js`：状态机、UI交互、性能调度、导出/截图
- `shared-src/index.html`：页面结构
- `shared-src/styles.css`：极简界面样式与主题

## 已实现增强（高价值集合）

1. 单人/多人模式切换  
2. 关键点显示开关  
3. 质量提示（距离/偏转）  
4. 截图导出  
5. JSON会话导出  
6. 平滑强度滑杆  
7. 置信阈值滑杆  
8. 隐私模式（默认开启，不记日志）  
9. 性能三档（高性能/均衡/省电）  
10. 启动前健康检查（HTTPS、API支持）  
11. 错误码输出（如 `E_INSECURE_CONTEXT`）  
12. 显式状态机（idle/loading_model/starting_camera/tracking/stopped/error）  
13. 调试浮层（FPS/Latency/Faces/State）  
14. 资源回收（停止时释放摄像头与RAF）  
15. 快捷键（S启动/X停止/D调试）  
16. 主题切换（浅色/深色）  
17. 预设参数（会议/自拍/低配）  
18. 本地参数持久化（localStorage）  
19. 目标锁定（点击框体锁定，再点空白取消）  
20. 多目标关联ID（简单中心匹配）  
21. 丢失TTL防闪烁  
22. 丢失迟滞（连续丢失帧才提示）  
23. 推理预算调度（耗时高自动降频）  
24. 平均置信度展示  
25. 平均推理时延统计  
26. 多源CDN回退（jsdelivr/unpkg）  
27. GPU失败自动降级CPU  
28. 最小框尺寸过滤  
29. 异常框裁剪（clamp到视频边界）  
30. 发布版与本地版分离维护

## 同步

```powershell
cd C:\Users\Administrator\Desktop\人脸识别
powershell -ExecutionPolicy Bypass -File .\scripts\sync.ps1
```

## 本地运行

```powershell
cd C:\Users\Administrator\Desktop\人脸识别\local-dev
py -m http.server 5600
```

浏览器打开 `http://localhost:5600`。

## 发布到 GitHub Pages

仓库：`https://github.com/koajsj/facerec`

1. 推送 `gh-pages` 目录内容到 `main` 分支  
2. GitHub `Settings -> Pages` 选择 `Deploy from a branch`  
3. 分支选择 `main`，目录选择 `/ (root)`  
4. 访问 `https://koajsj.github.io/facerec/`

## 算法建议（后续可继续迭代）

- 升级到 Face Landmarker，做眨眼/张嘴事件和更稳定头姿估计  
- 引入 OneEuro Filter，提升快动/慢动场景统一体验  
- 增加 IoU 跟踪与ID重关联，提升多人稳定性  
- 接入离线样本回归，自动比较版本性能退化
