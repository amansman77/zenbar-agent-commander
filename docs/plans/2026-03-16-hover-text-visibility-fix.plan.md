# Hover 텍스트 가독성 문제 수정 계획

## Summary

프로젝트 리스트와 task 리스트 아이템에 마우스 오버했을 때 배경색은 변경되지만 텍스트 대비가 함께 조정되지 않아 가독성이 무너지는 문제를 수정한다.  
핵심은 hover/selected 상태에서 카드 배경색과 텍스트 색상을 함께 제어하고, 자식 텍스트가 부모 색상을 상속하지 못해 발생하는 충돌을 제거하는 것이다.

## Goals

- hover 상태에서 project/task 카드의 제목, 메타 정보, 경로 텍스트가 모두 읽히도록 한다.
- selected 상태와 hover 상태가 충돌하지 않도록 시각 규칙을 분리한다.
- status badge(Completed, Failed, Stopped 등)는 카드 hover 영향으로 가독성이 깨지지 않도록 유지한다.
- 현재 데스크톱 레이아웃을 해치지 않는 범위에서 최소 수정으로 반영한다.

## Problem Statement

현재 UI에서 다음 현상이 발생한다.

- project/task 카드 hover 시 배경색이 진해진다.
- 하지만 제목 외의 텍스트(path, subtitle, meta)는 기존 회색 계열을 유지한다.
- 그 결과 진한 배경 위에서 보조 텍스트가 거의 보이지 않는다.
- selected 상태에서도 일부 서브 텍스트가 낮은 대비를 유지해 가독성이 떨어질 수 있다.

추정 원인은 다음과 같다.

1. 카드 컨테이너에만 hover 배경색이 적용되고 foreground 색은 함께 바뀌지 않음
2. 자식 요소가 `text-slate-*`, `text-muted-*` 같은 고정 텍스트 색을 직접 가짐
3. hover / selected / badge 스타일 우선순위가 섞여 있음

## UX Decision

상태별 시각 규칙을 다음처럼 고정한다.

- **default**
  - 밝은 surface
  - 진한 본문 텍스트
  - 보조 텍스트는 중간 명도
- **hover**
  - 약간 강조된 배경
  - 본문 텍스트는 충분히 진하게 유지
  - 보조 텍스트도 한 단계 진하게 조정
- **selected**
  - 명확한 강조 배경
  - 본문 텍스트는 흰색 또는 강조 foreground
  - 보조 텍스트는 흰색의 약한 톤
- **badge**
  - 카드 상태와 독립된 의미 색 유지
  - hover/selected의 영향을 최소화

## Implementation Changes

### 1. 리스트 아이템 상태 스타일 정리

project item / task item 컴포넌트의 루트 컨테이너에서 다음 상태를 명시적으로 구분한다.

- default
- hover
- selected
- selected + hover

hover 시에는 `background`, `border`, `foreground`를 함께 갱신한다.  
selected 시에는 hover보다 높은 우선순위로 selected 색 규칙을 유지한다.

### 2. 자식 텍스트 색상 상속 구조로 정리

다음 요소들이 고정 회색 클래스를 직접 가지고 있다면 제거 또는 상태 기반 클래스로 변경한다.

- title
- subtitle
- path
- workspace text
- secondary metadata

원칙:

- 제목은 가능하면 `text-inherit`
- 보조 텍스트는 default / hover / selected 상태별 클래스로 제어
- 부모가 selected일 때 자식이 여전히 `text-slate-500` 같은 색을 유지하지 않도록 수정

### 3. 상태 토큰 또는 클래스 매핑 도입

Tailwind를 사용 중이라면 각 상태를 단순 문자열 조합이 아니라 명시적인 매핑으로 정리한다.

예시 방향:

- item base classes
- hover classes
- selected classes
- child secondary text classes
- selected child secondary text classes

이렇게 해두면 project/task 모두 같은 규칙을 재사용할 수 있다.

### 4. badge 스타일 분리

Completed / Failed / Stopped badge는 카드 hover/selected에 의해 글자색이 의도치 않게 바뀌지 않도록 독립 클래스로 유지한다.

확인 포인트:

- hover된 진한 카드 위에서도 badge 텍스트가 유지되는지
- selected 카드 안에서도 badge 색 의미가 유지되는지

### 5. 접근성 대비 확인

최소한 다음 조합의 시각 대비를 점검한다.

- hover background vs title
- hover background vs secondary text
- selected background vs title
- selected background vs secondary text
- selected background vs badge

특히 path/workspace 텍스트가 충분히 읽히는지를 우선 확인한다.

## Suggested Edit Scope

다음 범위 중심으로 수정한다.

- task list item 컴포넌트
- project list item 컴포넌트
- 공통 list item style utility 또는 className builder
- 상태 badge 컴포넌트
- 필요 시 color token / semantic class 정리

## Acceptance Criteria

- project 카드 hover 시 프로젝트명과 경로 텍스트가 모두 읽힌다.
- task 카드 hover 시 제목, 실행 정보, workspace/path 텍스트가 모두 읽힌다.
- selected 상태에서 hover해도 텍스트 대비가 무너지지 않는다.
- Completed / Failed / Stopped badge의 의미 색이 유지된다.
- 기존 클릭 선택 동작과 레이아웃은 깨지지 않는다.

## Test Plan

### Manual

1. 프로젝트 리스트에서 카드 hover
   - 제목/경로가 모두 읽히는지 확인
2. task 리스트에서 여러 상태 카드 hover
   - Completed / Failed / Stopped 각각 확인
3. 선택된 카드에 다시 hover
   - selected 대비가 유지되는지 확인
4. 긴 path / workspace 텍스트가 있는 카드 hover
   - 잘리는 경우에도 최소한 읽기 가능한 대비인지 확인
5. 다크 톤 강조 배경을 사용하는 현재 테마에서 전체 밸런스 확인

### Regression

- 카드 클릭 선택 기능 정상 동작
- task detail 패널 선택 연동 정상
- badge 색상 의미 유지
- 모바일/좁은 폭에서도 hover 스타일 class 충돌 없음

## Out of Scope

- 전체 레이아웃 재설계
- 모바일 전용 구조 개편
- 색상 시스템 전체 리브랜딩
- focus-visible / keyboard navigation 개선
  - 필요하면 후속 작업으로 분리

## Implementation Notes for AI Agent

- 기존 코드에서 `hover:bg-*`만 있고 `hover:text-*` 또는 자식 상태 클래스가 없는 부분을 먼저 찾는다.
- 자식 요소에 고정된 회색 텍스트 클래스가 있으면 hover/selected 상태와 충돌하는지 점검한다.
- 가능하면 project/task 카드에 공통 스타일 패턴을 적용해 중복을 줄인다.
- 선택 상태(selected)는 hover보다 우선하도록 class order를 정리한다.
- 최소 수정으로 해결하되, 추후 공통 컴포넌트화가 가능하도록 구조를 남긴다.
