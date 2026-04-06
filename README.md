# Ryan Chess

Next.js 기반 체스 서비스입니다.

- `AI 대전`: 브라우저 안에서 돌아가는 Stockfish
- `방 대전`: WebRTC direct 우선, Vercel relay fallback
- `backend`: Vercel Route Handler only

## 실행

```bash
pnpm install
pnpm dev
```

브라우저에서 `http://localhost:3000`을 열면 됩니다.

## 멀티플레이 구조

현재 방 대전은 다음처럼 동작합니다.

- 방 메타데이터는 서버에 저장
- 플레이어 presence는 플레이어별 heartbeat로 갱신
- signaling 메시지는 플레이어별 inbox에 저장
- relay 메시지는 플레이어별 inbox에 저장
- 호스트(백)가 대국 상태를 authoritative 하게 관리
- WebRTC direct가 열리면 브라우저끼리 직접 교환
- 직접 연결이 안 되면 같은 메시지를 Vercel relay polling으로 전달

## TURN 설정

이 프로젝트는 TURN 없이도 `Vercel-only`로 플레이할 수 있게 설계되어 있습니다. 다만 STUN만으로는 일부 네트워크 환경에서 direct 연결이 실패할 수 있어서, direct 성공률을 높이고 싶다면 TURN을 추가할 수 있습니다.

`.env.local` 또는 Vercel Environment Variables에 아래 값을 넣을 수 있습니다.

```bash
NEXT_PUBLIC_WEBRTC_STUN_URLS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
NEXT_PUBLIC_WEBRTC_TURN_URLS=turn:your-turn-server.example.com:3478?transport=udp,turn:your-turn-server.example.com:3478?transport=tcp
NEXT_PUBLIC_WEBRTC_TURN_USERNAME=your-username
NEXT_PUBLIC_WEBRTC_TURN_CREDENTIAL=your-password
```

설명:

- `NEXT_PUBLIC_WEBRTC_STUN_URLS`: 쉼표로 구분한 STUN URL 목록
- `NEXT_PUBLIC_WEBRTC_TURN_URLS`: 쉼표로 구분한 TURN/TURNS URL 목록
- `NEXT_PUBLIC_WEBRTC_TURN_USERNAME`: TURN 사용자명
- `NEXT_PUBLIC_WEBRTC_TURN_CREDENTIAL`: TURN 비밀번호 또는 credential

TURN 값이 비어 있어도 앱은 계속 동작하며, direct 연결이 안 잡히면 자동으로 `Vercel relay fallback`으로 진행합니다.

## 디버깅

방 화면 오른쪽에 `Browser Events` 패널이 있습니다. 여기서 아래 흐름을 확인할 수 있습니다.

- `Offer start`
- `Signal sent`
- `Signal received`
- `ICE gathering`
- `ICE connection`
- `Peer connection`
- `Data channel open`

여기서 `offer/answer`는 오가는데 `ICE connection`이 계속 `disconnected` 또는 `failed`로 끝나도, `Relay sent/Relay received`가 보이면 Vercel relay로 계속 대국할 수 있습니다.

## 검증

```bash
pnpm lint
pnpm build
```
