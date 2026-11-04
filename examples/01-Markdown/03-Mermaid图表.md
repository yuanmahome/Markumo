# Mermaid 图表教程

使用项目锁定的 Mermaid 11.16.1。严格安全模式禁用脚本、外部引用及 HTML 标签配置；语法错误时显示提示。

## flowchart

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
flowchart LR
  A[Markdown 文档] --> B[安全渲染]
  B --> C[HTML / PDF]
  B --> D[Word 图表]
```

## sequenceDiagram

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
sequenceDiagram
  participant U as 用户
  participant E as 编辑器
  U->>E: 保存文档
  E-->>U: 完成
```

## classDiagram

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
classDiagram
  class Document {
    +String title
    +save()
  }
  Document <|-- MarkdownDocument
```

## stateDiagram-v2

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
stateDiagram-v2
  [*] --> 编辑
  编辑 --> 已保存: 保存
  已保存 --> [*]
```

## erDiagram

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
erDiagram
  USER ||--o{ DOCUMENT : writes
  USER {
    int id
    string name
  }
```

## gantt

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
gantt
  title 写作计划
  dateFormat YYYY-MM-DD
  section 文档
  草稿 :a1, 2026-01-01, 2d
  审阅 :after a1, 1d
```

## gitGraph

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
gitGraph
  commit
  branch draft
  checkout draft
  commit
  checkout main
  merge draft
```

## pie

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
pie title 文件类型
  "Markdown" : 60
  "Code" : 40
```

## mindmap

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
mindmap
  root((文档))
    编辑
    预览
    导出
```

## timeline

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
timeline
  title 文档流程
  草稿 : 编写
  审阅 : 修改
  发布 : 导出
```

## xychart-beta

编辑下面的 Mermaid 源码，再观察预览。图形比例随内容变化。

```mermaid
xychart-beta
  title "进度"
  x-axis [Mon, Tue, Wed]
  y-axis "数量" 0 --> 10
  bar [2, 5, 8]
```
