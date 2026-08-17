# 侧栏 Design QA

## 对照目标

- Source visual truth: `/tmp/hermes-yaoyao-sidebar-qa/grok-source-desktop.png`
- Final implementation: `/tmp/hermes-yaoyao-sidebar-qa/implementation-final-1237x788.png`
- Search state: `/tmp/hermes-yaoyao-sidebar-qa/implementation-final-search-1237x788.png`
- Collapsed state: `/tmp/hermes-yaoyao-sidebar-qa/implementation-final-collapsed-1237x788.png`
- Mobile drawer: `/tmp/hermes-yaoyao-sidebar-qa/implementation-final-mobile-390x844.png`
- Full-view comparison: `/tmp/hermes-yaoyao-sidebar-qa/comparison-full.png`
- Focused sidebar comparison: `/tmp/hermes-yaoyao-sidebar-qa/comparison-sidebar.png`

## 归一化

- Desktop source and implementation are both 1237 × 788 pixels, CSS viewport 1237 × 788, device scale factor 1.
- Focused comparison crops the same left 264 × 788 region from both images and appends them side by side without scaling.
- Mobile implementation is 390 × 844 pixels at CSS viewport 390 × 844 and device scale factor 1. The reference only defines the desktop information hierarchy, so mobile is evaluated as a responsive continuation rather than a pixel clone.
- State: light theme, authenticated fake-9119 account, chat workspace, two history sessions.

## Full-view comparison

The implementation now keeps the same dominant composition as the source: a restrained light single-column sidebar separated from a large canvas, with the composer remaining the primary main-canvas interaction. Main-canvas copy and controls intentionally follow Hermes YaoYao requirements rather than cloning Grok product content.

## Focused sidebar comparison

- Information order matches: brand/collapse → search → new chat → feature entries → history → account area.
- Search and new-chat rows use the same 40px full-width rhythm and low-contrast active fill.
- History is an unboxed, compact list with pinned treatment and date buckets.
- The footer stays pinned to the bottom. The extra Agent selector is intentional because multi-Profile switching is a product requirement.

## Required fidelity surfaces

- Fonts and typography: system sans-serif, 12–13px navigation hierarchy and compact metadata closely match the source density. Product name and secondary previews are intentional Hermes additions.
- Spacing and layout rhythm: expanded width 264px, top row 58px, search/new-chat 40px, 10px horizontal inset; search input occupies the exact trigger rectangle at x=10, y=58, width=243, height=40.
- Colors and tokens: neutral white/gray surfaces, black primary type, quiet dividers and one low-contrast selected row match the source. Existing theme tokens retain dark-theme support.
- Image quality and assets: the canonical mobile AppIcon source is used at native aspect ratio; no substitute logo or CSS drawing is present.
- Copy and content: “搜索 / 新建聊天 / 历史记录” match the requested structure. Hermes-only entries remain “群聊 / 文件库 / 产物”.

## Interaction and responsive evidence

- Search opens in place, focuses the input, and Escape clears/restores the trigger.
- Collapsed width is 68px; search and new-chat remain available as named icon buttons, and collapsed search expands the sidebar before focusing.
- Collapse state persists across reload.
- The 390px drawer is 304px wide, reports `aria-hidden=false` while open, and makes the main canvas inert.
- Browser console error/warning collection was empty for the final desktop/search/collapse/mobile flow.

## Comparison history

### Pass 1 — blocked

- P1: search opened a second input inside the history body instead of replacing the top search row.
- P1: collapsed mode removed search and new-chat actions.
- P2: history lacked today/yesterday/earlier scan grouping.

Fixes: positioned the live search input in the top row, synchronized close state across desktop/mobile copies, retained icon-only primary actions in collapsed mode, auto-expanded collapsed search, and added timestamp-derived history buckets.

### Pass 2 — passed

Post-fix screenshots confirm the search trigger and input share the exact rectangle, collapsed actions remain usable, and the history bucket appears without disturbing the fixed footer. No actionable P0/P1/P2 mismatch remains.

## Follow-up polish

- P3: session rows retain a secondary preview line for faster Hermes history scanning.

## Account and collapse annotation pass

- Source visual truth: current browser annotations supplied with the user request, targeting the duplicate Agent/account rows, desktop wordmark, and collapsed control placement.
- Final expanded implementation: `/tmp/hermes-yaoyao-sidebar-qa/account-merged-expanded.png`
- Final collapsed implementation: `/tmp/hermes-yaoyao-sidebar-qa/account-merged-collapsed.png`

Findings resolved:

- The Agent selector and account row are now one account switcher: avatar, username, active Agent, Agent menu, theme control, and logout menu live in the same footer surface.
- Desktop rail uses only the mobile AppIcon; the `夭夭 Web` wordmark is no longer rendered there.
- In the 68px collapsed rail, the collapse/expand control moves to the bottom directly above the signed-in account. The theme action hides in this compact state and remains available when expanded or on mobile.

No new actionable P0/P1/P2 issue was observed in the expanded or collapsed browser-rendered states.

## New-chat empty-state annotation pass

- Source visual truth: current user-supplied mobile browser annotation requesting a large gray product logo and the copy “聊点什么”.
- Final browser-rendered implementation: `/tmp/hermes-yaoyao-sidebar-qa/new-chat-empty.png`

The ordinary chat empty state now renders the canonical mobile AppIcon at 150px mobile / 180px desktop with muted gray opacity and a single “聊点什么” prompt. Existing conversation timelines and the group-chat empty state retain their separate message-oriented presentation.

## Transport-warning annotation pass

The trusted-LAN plaintext banner is no longer rendered. The explicit server-side configuration gate for non-loopback HTTP remains unchanged; only the persistent canvas warning was removed as requested.

## Composer dashboard-alignment pass

- Source visual truth: user-supplied Dashboard composer annotations showing the reasoning slider popover, settings dropdown, and context-usage row.
- Final reasoning implementation: `/tmp/hermes-yaoyao-sidebar-qa/composer-reasoning-popover.png`
- Final settings implementation: `/tmp/hermes-yaoyao-sidebar-qa/composer-settings-popover.png`

The ordinary-chat composer now exposes an anchored reasoning slider with the same default-to-maximum range and rainbow rail, an anchored settings popover for tool-trace visibility, and a context row showing used, maximum, remaining tokens, and progress. The initial fallback is `0 / 256.0k · 剩余 256.0k`; live 9119 usage replaces it when available.

## Settings-menu annotation pass

- Source visual truth: Dashboard settings dropdown annotation with “显示工具轨迹” and “语音输入设置”.
- Final browser-rendered implementation: `/tmp/hermes-yaoyao-sidebar-qa/composer-settings-voice-row.png`

The settings popover now matches the two-row structure. Tool trace is functional. Voice input remains outside the current release scope, and choosing its settings row explicitly reports that it is not yet enabled rather than exposing a deceptive microphone control.

## Library preview modal pass

File-library and artifact-grid selection now opens a centered modal rather than a persistent right Inspector. The shared preview surface handles images, video, audio, PDFs, Office documents, spreadsheets, text/code, links, and generic downloadable files. A real current-profile text file was opened successfully in the browser-rendered modal; the focused E2E path opens and closes a PDF modal without console errors.

## Contextual navigation pass

The feature strip now hides the current workspace and the artifact shortcut. In a group room it presents “对话 / 文件库”, preventing a redundant “群聊” destination while retaining direct artifact routes and source links.

## Transparent conversation-header pass

The normal-chat timeline header now renders as a transparent overlay with no horizontal divider or title band. An active stored session exposes a single top-right ellipsis action that opens only rename and delete controls; group-room headers retain their own management controls.

## Product-scope navigation pass

The chat workspace now shows only “群聊 / 文件库” as alternative destinations. The current “对话” item is omitted, and the artifact route redirects to chat with no visible product entry.

## Agent-name source pass

Bootstrap now enriches Hermes profiles from the YaoYao plugin `/profiles` settings endpoint. Session rows use the configured `agentName` at the right edge, falling back only when the plugin does not provide a name. A current browser run verified the plugin-configured name “竹儿” on session entries.

## Pinned-session pass

Pinned sessions are now rendered as their own “已置顶 N” section, with the existing pin glyph retained on each session row and the configured Agent name at the right edge. Server order remains authoritative; the client only supplies the visual grouping.

final result: passed
