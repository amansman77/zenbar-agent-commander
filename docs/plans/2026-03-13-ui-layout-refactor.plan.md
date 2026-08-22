# 2026-03-13 UI Layout Refactor plan

## Summary

현재 Web Commander UI는 정보 계층이 불분명하고, 카드 중심 배치와 콘텐츠 overflow 때문에 가독성이 낮으며, 특정 영역의 길이에 따라 전체 레이아웃이 쉽게 깨진다. 특히 `Task Detail`과 `Plan output`이 화면을 밀어내면서 사용자가 프로젝트 선택, 태스크 목록 탐색, 상세 확인을 안정적으로 수행하기 어렵다.

이번 작업의 목표는 UI를 **Agent Commander 중심 구조**로 재편하는 것이다. 핵심은 다음 세 가지다.

1. 전체 화면을 **Projects / Tasks / Task Detail**의 3열 레이아웃으로 재구성한다.
2. 생성 폼은 상시 노출 카드에서 제거하고, **modal 또는 drawer**로 이동한다.
3. `Plan output`과 긴 경로 문자열은 **독립 scroll / wrap / truncation 정책**으로 제어해 레이아웃 붕괴를 방지한다.

이 변경을 통해 사용자는 다음을 더 잘 할 수 있어야 한다.

* 프로젝트를 빠르게 전환할 수 있다.
* 선택한 프로젝트의 태스크 목록을 안정적으로 탐색할 수 있다.
* 선택한 태스크의 상태, 메타데이터, 액션, plan output을 한 눈에 확인할 수 있다.
* 긴 텍스트나 큰 출력이 있어도 전체 레이아웃이 깨지지 않는다.

---

## Goals

* Agent Commander 사용 흐름에 맞는 정보 계층 구조 확립
* 반응형에서도 깨지지 않는 안정적인 레이아웃 구성
* 긴 경로/로그/markdown 출력으로 인한 overflow 문제 해결
* 시각적 가독성 개선
* 상태 기반 액션 영역 명확화

---

## Non-Goals

* 백엔드 API 계약 변경
* task 상태 머신 로직 변경
* runtime event stream 데이터 구조 변경
* 디자인 시스템 전체 재정의

---

## Problem Statement

현재 UI의 주요 문제는 아래와 같다.

### 1. 정보 구조가 모호함

현재 화면은 `Project creation`, `Task creation`, `Project list`, `Task list`, `Task detail`이 모두 카드로 동등하게 배치되어 있다. 이로 인해 사용자가 현재 어떤 객체를 보고 있는지, 어떤 정보가 1차 정보이고 어떤 정보가 부가 정보인지 파악하기 어렵다.

### 2. 레이아웃이 콘텐츠 길이에 종속됨

`Plan output`, runtime session id, workspace path, task path 같은 긴 문자열이 컨테이너 폭 제한 없이 노출되며, 줄바꿈 정책도 불안정하다. 그 결과 카드 폭이 늘어나거나 높이가 과도하게 증가하여 전체 레이아웃이 무너진다.

### 3. 폼이 항상 화면을 점유함

프로젝트 생성, 태스크 생성 폼이 상시 노출되어 메인 작업 공간을 차지한다. 그러나 실제 사용 흐름에서 생성은 보조 행위이고, 핵심은 기존 프로젝트와 태스크를 탐색/감독하는 것이다.

### 4. 상세 패널의 밀도와 읽기 흐름이 좋지 않음

Task Detail 내부에 상태, 메타데이터, 액션, 출력이 좁은 폭으로 연속 배치되어 있고, `Plan output`이 과도하게 큰 영역을 차지해 사용자가 핵심 정보를 빠르게 훑기 어렵다.

---

## Target UX

사용자는 다음 흐름으로 화면을 이용할 수 있어야 한다.

1. 좌측에서 프로젝트를 선택한다.
2. 가운데에서 해당 프로젝트의 태스크 목록을 본다.
3. 태스크를 클릭하면 우측 패널에 상세 정보가 열린다.
4. 우측 패널에서 상태, 실행 모드, runtime session, workspace, 액션 버튼, plan output을 확인한다.
5. 새 프로젝트/새 태스크 생성은 필요 시 버튼을 눌러 modal 또는 drawer에서 수행한다.

즉, 기본 화면은 **감독(work supervision)** 중심이어야 하고, 생성은 보조 인터랙션이어야 한다.

---

## Proposed Information Architecture

### Primary layout

* **Left sidebar**: Projects
* **Center panel**: Tasks
* **Right detail panel**: Task Detail

### Secondary interactions

* New Project: modal 또는 drawer
* New Task: modal 또는 drawer

### Suggested desktop grid

```txt
260px | 420px | minmax(480px, 1fr)
```

또는 CSS Grid 기준:

```css
grid-template-columns: 260px 420px minmax(480px, 1fr);
```

### Suggested tablet/mobile fallback

* `>= 1200px`: 3-column layout
* `768px ~ 1199px`: 2-column layout (`Projects` 축소 / `Tasks + Detail` 재배치)
* `< 768px`: stacked layout with section tabs or accordions

---

## Proposed UI Structure

### 1. App Shell

구성 예시:

* Top header

  * product name: Web Commander
  * active project summary
  * primary actions: `New Project`, `New Task`
* Main content

  * Projects sidebar
  * Tasks panel
  * Task Detail panel

### 2. Projects Sidebar

포함 요소:

* sidebar title: `Projects`
* optional subtitle: connected repositories / orchestration scope
* project list items

  * name
  * repository path (secondary text, truncated)
  * selected state 강조
* footer action

  * `+ New Project`

리스트 아이템 요구사항:

* 선택 상태가 시각적으로 명확해야 함
* 긴 path는 단일 라인 + ellipsis 처리
* hover / active / selected state 분리

### 3. Tasks Panel

포함 요소:

* panel header: `Tasks`
* selected project context 표시
* optional filter / status pills
* `+ New Task` 버튼
* task list

각 task item 표시 필드:

* task title
* execution mode (`plan`, `execute`)
* task slug or short id
* workspace path (ellipsis)
* status badge (`Completed`, `Running`, `Waiting Approval`, `Stopped`, `Failed`)

리스트 요구사항:

* 카드형보다 밀도 높은 row/card hybrid 추천
* selected task는 우측 패널과 연결되어야 함
* status badge는 강한 시각적 신호 제공

### 4. Task Detail Panel

상단부터 다음 섹션 순서로 정리한다.

1. Title row

   * task title
   * status badge
2. Meta grid

   * Project
   * Execution mode
   * Runtime session
   * Task workspace
3. Action row

   * Approve
   * Stop
   * Retry
4. Output section

   * `Plan output` 또는 `Execution output`
   * scrollable container
5. Optional extra section

   * events / timeline / logs (추후)

상세 패널의 원칙:

* 메타데이터는 2열 grid로 정리
* 긴 값은 wrap 정책 명확화
* 액션 버튼은 상태에 따라 disabled / hidden 처리
* 출력은 독립적인 scroll 영역으로 격리

---

## Overflow and Readability Rules

이 작업의 핵심 안정화 포인트다.

### Long text policy

적용 대상:

* repository path
* workspace path
* runtime session id
* slug
* markdown output 내부 긴 코드 라인

정책:

* list 영역: `truncate` + tooltip/title
* detail metadata: `break-all` 또는 `break-words`
* code/output 영역: `overflow-x-auto`, `overflow-y-auto`

### Plan Output policy

필수 요구사항:

* 최대 높이 제한 필요
* 내부 scroll 필요
* 본문과 시각적으로 분리
* monospace or markdown style 명확화

권장 스타일 예시:

```css
.planOutput {
  max-height: 420px;
  overflow: auto;
  border-radius: 12px;
  padding: 16px;
}
```

### Panel height policy

* 전체 viewport 기준 높이 계산
* 각 패널 내부에서만 scroll되도록 설계
* body 전체 스크롤과 패널 스크롤이 충돌하지 않도록 주의

예시:

```css
.appMain {
  height: calc(100vh - var(--header-height));
}

.panel {
  min-height: 0;
  overflow: hidden;
}

.panelBody {
  min-height: 0;
  overflow: auto;
}
```

---

## Visual Design Direction

현재보다 더 단단하고 읽기 쉬운 운영도구 스타일을 지향한다.

### Tone

* 운영툴 / 감독툴에 맞는 차분한 UI
* 과한 카드 장식 제거
* 정보 밀도는 높이되 답답하지 않게 구성

### Recommended styling

* neutral background + white panels
* subtle border
* radius 10~16px
* spacing 12 / 16 / 20 단위 정리
* shadow는 최소화

### Typography

* title / section / meta / secondary text 위계 명확화
* path / ids / output은 monospace 또는 semimono 느낌으로 구분
* 한 화면에 너무 큰 텍스트 크기 편차를 두지 않음

### Status colors

* Completed: green
* Running: blue
* Waiting Approval: amber
* Stopped: gray
* Failed: red

배지는 pill 형태로 유지하되 대비를 높인다.

---

## Suggested Implementation Plan

### Step 1. Layout shell refactor

목표:

* 기존 카드 나열 구조 제거
* app shell + 3-column grid 도입

작업:

* 최상위 페이지 컴포넌트 레이아웃 재구성
* `ProjectsSidebar`, `TasksPanel`, `TaskDetailPanel`로 시각적 책임 분리
* viewport height 기반 레이아웃 적용

완료 조건:

* desktop에서 3열 구조가 안정적으로 보임
* 특정 카드 길이에 따라 다른 패널 폭이 무너지지 않음

### Step 2. Move creation forms out of main layout

목표:

* create project / create task 폼을 modal 또는 drawer로 이동

작업:

* `New Project` 버튼으로 open
* `New Task` 버튼으로 open
* 기존 인라인 카드 제거

완료 조건:

* 메인 화면에서 생성 폼이 사라짐
* 생성 기능은 유지됨

### Step 3. Refactor task list presentation

목표:

* 태스크 목록 가독성 개선

작업:

* task item compact card/row 구성
* status badge 강화
* selected state 명확화
* 긴 path truncate 처리

완료 조건:

* 한 화면에서 더 많은 task 탐색 가능
* task item 클릭 시 detail 연결이 자연스러움

### Step 4. Refactor task detail panel

목표:

* 상세 정보 계층 정리

작업:

* header / meta / action / output section 분리
* meta grid 도입
* 버튼 row 정리
* 긴 문자열 wrap 처리

완료 조건:

* 상세 패널만 봐도 상태와 다음 행동이 바로 이해됨

### Step 5. Stabilize output rendering

목표:

* plan output 때문에 레이아웃이 깨지지 않도록 보장

작업:

* output container max height 적용
* markdown/code block style 정리
* horizontal overflow 처리
* `white-space` 정책 검토

완료 조건:

* 긴 출력에서도 3열 레이아웃 유지
* output은 독립 scroll 영역에서 읽힘

### Step 6. Responsive polish

목표:

* 좁은 화면에서도 usable 하게 유지

작업:

* breakpoints별 column collapse 설계
* 필요 시 detail panel을 stacked layout으로 전환
* sidebar width 조정

완료 조건:

* tablet width에서도 깨지지 않음

---

## Suggested Component Breakdown

구현 프레임워크가 React 기준이라면 아래 분리를 권장한다.

* `CommanderPage`
* `CommanderHeader`
* `ProjectsSidebar`
* `ProjectListItem`
* `TasksPanel`
* `TaskListItem`
* `TaskDetailPanel`
* `TaskMetaGrid`
* `TaskActionBar`
* `TaskOutputViewer`
* `CreateProjectModal`
* `CreateTaskModal`

공통 UI utility:

* `StatusBadge`
* `EmptyState`
* `ScrollablePanel`
* `TruncatedText`

---

## State Rules

UI에서 상태를 아래처럼 취급한다.

### Selection state

* selected project가 없으면 tasks panel은 empty state
* selected task가 없으면 detail panel은 placeholder state

### Action state

* `Approve`: waiting approval 또는 plan completed 후 승인 가능 상태에서만 enabled
* `Stop`: running state에서만 enabled
* `Retry`: failed / stopped / completed after failure recovery cases 등 정책에 맞게 enabled

### Empty states

* Projects 없음: first project 생성 유도
* Tasks 없음: selected project에 대해 첫 task 생성 유도
* Task 미선택: task 선택 안내

---

## Acceptance Criteria

아래 조건을 만족해야 한다.

1. 데스크톱 화면에서 `Projects / Tasks / Task Detail` 3열 구조가 유지된다.
2. `Plan output` 길이가 길어도 다른 패널의 폭과 배치가 깨지지 않는다.
3. 프로젝트 생성 및 태스크 생성 폼은 상시 노출되지 않고 modal 또는 drawer에서 열린다.
4. 긴 path와 ids는 list에서는 truncate, detail에서는 wrap 또는 scroll 정책으로 제어된다.
5. Task Detail은 `status → metadata → actions → output` 순서로 읽기 쉬운 구조를 가진다.
6. selected / hover / disabled 상태가 시각적으로 구분된다.
7. 최소한 현재 스크린샷 수준의 overflow 문제는 재현되지 않는다.

---

## QA Checklist

### Layout

* [ ] 1440px 이상에서 3열 유지
* [ ] 1280px 부근에서도 detail panel이 과도하게 좁아지지 않음
* [ ] body 전체 horizontal scroll이 생기지 않음

### Overflow

* [ ] 매우 긴 workspace path가 있어도 레이아웃이 안 깨짐
* [ ] runtime session id가 길어도 detail panel 내부에서 처리됨
* [ ] markdown code block이 길어도 output container 내부에서만 scroll 됨

### Interaction

* [ ] project 클릭 시 task list 갱신
* [ ] task 클릭 시 detail panel 갱신
* [ ] new project modal 열기/닫기 동작 정상
* [ ] new task modal 열기/닫기 동작 정상

### Visual

* [ ] selected task와 unselected task 구분 가능
* [ ] status badge 색상 대비 충분
* [ ] 버튼 disabled 상태가 명확함

---

## Implementation Notes for the Agent

* 기존 구조를 최소 수정으로 땜질하지 말고, **layout shell부터 재정리**하는 방향을 우선한다.
* CSS가 분산되어 있다면 우선 레이아웃 책임을 한 곳으로 모으고 panel 단위 스타일을 분리한다.
* 가능하다면 `min-width: 0`, `min-height: 0` 누락 여부를 우선 점검한다. 많은 overflow 문제는 여기서 발생한다.
* flex 기반이라면 panel 내부 scroll 제어가 어려울 수 있으므로 최상위는 grid를 우선 검토한다.
* 텍스트 truncation과 detail wrap 정책을 섞어 써야 한다. 모든 곳에 ellipsis를 적용하면 detail 가독성이 떨어진다.
* 출력 영역은 일반 텍스트가 아니라 markdown/code rendering 상황까지 고려한다.

---

## Recommended Execution Order

1. 현재 페이지의 최상위 layout 구조 파악
2. main shell을 grid 기반 3-panel로 변경
3. creation form 제거 및 modal/drawer 이동
4. tasks list compact redesign
5. task detail sectioning
6. output viewer overflow stabilization
7. responsive polish
8. QA 및 screenshot 비교

---

## Deliverables

최소 산출물:

* refactored commander page layout
* project/task creation modal or drawer UI
* stabilized task detail panel
* overflow-safe output viewer

추가로 남기면 좋은 것:

* 변경 전/후 구조 요약
* 주요 CSS/layout 결정사항
* responsive 전략 메모

---

## Definition of Done

다음이 충족되면 완료로 본다.

* UI가 더 이상 콘텐츠 길이 때문에 깨지지 않는다.
* 사용자가 프로젝트 → 태스크 → 상세 보기 흐름을 자연스럽게 수행할 수 있다.
* 생성 폼이 메인 감독 화면을 방해하지 않는다.
* 현재 스크린샷 대비 가독성과 구조가 명확히 개선된다.
* 구현 결과가 운영툴다운 안정적인 밀도와 위계를 가진다.
