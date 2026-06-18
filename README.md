# Claude Tower

여러 원격 서버에 걸친 **Claude Code 세션을 SSH로 한 화면에서 관리하는 터미널 대시보드**입니다. Ink(터미널용 React) 기반의 TUI이며, **API 비용 0** 원칙으로 동작합니다 — 세션 정보는 로컬/원격 파일에서 읽고, rate limit은 OAuth usage 엔드포인트(메타데이터)만 조회하며, AI 윤문은 사용자의 인터랙티브 `claude`(구독)로 처리합니다.

## 주요 기능

- **세션 목록** — 등록된 서버들의 `~/.claude/projects` 트랜스크립트를 스캔해 한 곳에 모아 표시 (제목·브랜치·토큰·비용)
- **라이브 판별** — 실제 `claude` 프로세스를 열거해 busy(●노랑)/idle(●초록)/offline(○) 표시, tmux 안이면 입력 타겟까지 추적
- **채팅 입력** — 라이브 세션에 tmux `send-keys`로 메시지 전송 (`i`)
- **cmux 연동** — 세션을 실제 cmux 워크스페이스에서 열기. 라이브면 tmux attach, 오프라인이면 `claude --resume`으로 부활 (`o`)
- **새 세션 생성** — tmux 안에서 새 `claude` 세션 시작 (`n`)
- **rate limit 표시** — 상단에 5시간/7일 사용률 바
- **일일 업무 보고** (`D`) — 하루치 트랜스크립트를 재생해 요청·변경 파일·실행 명령을 추출, 프로젝트별로 묶어 마크다운으로 렌더. 로컬 저장(`s`) 및 새 cmux 세션을 통한 AI 윤문(`p`) 지원

## 요구사항

**대시보드를 실행하는 로컬 머신**
- Node.js ≥ 18
- `tmux` — 채팅 전송(`send-keys`) 및 세션 attach용
- `curl` — rate limit 조회 시 Node TLS가 거부되면 폴백
- (선택) `cmux` CLI — `o`/`n`/`p` 기능. 없으면 해당 키는 "cmux CLI 사용 불가"로 비활성
- (선택) rate limit 표시를 위한 Claude Code OAuth 토큰 — macOS는 Keychain, 그 외는 `~/.claude/.credentials.json`에서 자동으로 읽음

**대상 원격 서버 (SSH 접속 대상)**
- `python3` — 세션/프로세스 열거 스크립트 실행
- `tmux` — 라이브 세션의 입력 타겟 추적
- `~/.claude/projects` 구조의 Claude Code 트랜스크립트
- Linux의 경우 `/proc` (라이브 프로세스 판별에 사용)
- SSH 공개키 기반 접속 — SSH 에이전트(`SSH_AUTH_SOCK`)가 떠 있으면 자동 사용하고, 없으면 개인키 파일(`.pem` 포함)로 접속합니다. 암호걸린 키는 passphrase를 입력하면 됩니다(에이전트 사용 권장).

> **참고 — NFS 공유 홈**: fundus 클러스터처럼 홈 디렉터리가 NFS로 공유되면 한 서버만 등록해도 클러스터 전체 세션이 한 번에 보입니다. 공유 홈이 아니면 각 서버를 따로 등록해야 그 서버의 세션이 보입니다.

## 설치 & 실행

```bash
git clone <이 저장소>
cd claude-tower
npm install
npm run build      # tsc → dist/
npm start          # = node dist/cli.js
```

개발 중에는 빌드 없이 바로 실행할 수 있습니다:

```bash
npm run dev        # tsx src/cli.tsx
```

전역 명령으로 쓰려면 빌드 후 `npm link` (bin: `claude-tower`).

## 설정

설정은 사용자별 파일에 저장됩니다 — `~/.agent-view/config.json`. **첫 실행 시 비어 있는(원격 서버 없는) 상태로 생성**되며, 로컬 머신(`local`)은 항상 자동으로 포함됩니다. 원격 서버는 앱 안에서 추가하세요:

1. 실행 후 `Tab`으로 왼쪽 필터 패널로 이동
2. `a` 키 → 이름 / 호스트(IP 또는 SSH alias) / 사용자명 / 개인키 경로 / 키 암호 입력
   - 개인키 경로는 `.pem` 포함 임의의 키 파일. **SSH 에이전트를 쓰면 경로·암호를 비워도 됩니다.**
   - 키 암호(passphrase)는 암호걸린 키일 때만 입력 (없으면 Enter). 마스킹되어 표시됩니다.
   - 입력을 마치면 **실제로 SSH 접속을 시도해 성공할 때만 리스트에 추가**됩니다.
3. `d` 키로 삭제

직접 편집해도 됩니다. 스키마:

```json
{
  "servers": [
    {
      "name": "f7",
      "host": "10.0.0.7",
      "port": 22,
      "username": "your-username",
      "privateKeyPath": "~/.ssh/id_ed25519",
      "remoteClaudeDir": "~/.claude",
      "local": false
    }
  ]
}
```

`local` 항목은 저장하지 않아도 로드 시 자동으로 맨 앞에 추가됩니다. `privateKeyPath`는 선택(에이전트만 쓸 경우 생략 가능)이며, 암호걸린 키라면 `"passphrase": "..."`를 추가할 수 있습니다 — 이 경우 비밀이 평문으로 들어가므로 파일은 자동으로 `0600` 권한으로 저장됩니다.

## 키 바인딩

| 키 | 동작 |
|----|------|
| `Tab` | 패널 전환 (필터 → 세션 → 트랜스크립트) |
| `↑` `↓` | 항목 이동 / 트랜스크립트 스크롤 |
| `←` `→` | 패널 이동 |
| `Space` | (필터) Live 전용 토글 |
| `a` / `d` | (필터) 서버 추가 / 삭제 |
| `n` | 새 세션 생성 |
| `i` / `Enter` | 채팅 입력 (라이브 세션) — `Enter` 전송, `Esc` 나가기 |
| `o` | cmux에서 열기 (라이브=attach, 오프라인=resume) |
| `g` / `G` | (트랜스크립트) 처음 / 최신으로 |
| `r` | 새로고침 |
| `D` | 일일 업무 보고 열기/닫기 |
| `q` / `Ctrl-C` | 종료 |

**일일 보고 화면**: `↑↓` 스크롤 · `←→`(또는 `[` `]`) 날짜 이동 · `t` 오늘 · `s` 저장 · `p` AI 윤문 · `Esc` 닫기

## 공유 / 사용 시 알아둘 점

- **각자 자기 세션을 봅니다.** 세션 목록은 SSH로 접속한 *그 계정*의 `~/.claude/projects` 기준입니다. 본인 계정으로 서버를 등록하면 본인 세션만 보입니다 — 이 도구는 "공용 세션 대시보드"가 아니라 "각자 동일하게 쓰는 개인 도구"입니다.
- **시크릿은 저장소에 없습니다.** SSH 키는 런타임에 `~/.ssh`(또는 에이전트)에서, OAuth 토큰은 Keychain/`~/.claude/.credentials.json`에서 읽습니다. 설정도 저장소 밖(`~/.agent-view/`, `0600`)에 있습니다. 키 암호를 굳이 config에 저장하기보다 **SSH 에이전트 사용을 권장**합니다.
- **API 비용이 들지 않습니다.** rate limit은 사용량 메타데이터만 조회하고, 일일 보고 AI 윤문은 사용자의 인터랙티브 `claude`(구독)로 동작합니다.
