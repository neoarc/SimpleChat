# // VOID Chat

개인용 채팅 & 파일 공유 서버 — Discord 스타일, 셀프 호스팅

## 빠른 시작

```bash
npm install    # 최초 1회
npm start      # → http://localhost:3000
```

---

## config.json 설정 가이드

서버와 같은 폴더의 `config.json`으로 모든 설정을 관리합니다.
**서버 재시작 없이 파일 저장만 해도 즉시 반영됩니다.**

```json
{
  "allowedIPs": [
    "127.0.0.1",
    "192.168.1.10",
    "192.168.1.20"
  ],

  "nameMap": {
    "192.168.1.10": "Alice",
    "192.168.1.20": "Bob"
  },

  "port": 3000,
  "fileSizeLimitMB": 100
}
```

### allowedIPs
접속을 허용할 IP 목록. 목록에 없는 IP는 403 페이지로 차단됩니다.

- Windows: `ipconfig` → "IPv4 주소" 확인
- Mac/Linux: `ifconfig` 또는 `ip addr`

### nameMap
IP 주소를 사람 이름으로 표시합니다. 등록되지 않은 IP는 IP 그대로 표시됩니다.
config.json 저장 시 이미 열려 있는 브라우저에도 즉시 반영됩니다.

### channels
사이드바에 표시할 채널 목록을 정의합니다. 순서대로 표시되며 첫 번째 채널이 기본으로 열립니다.

- `id`: 채널 식별자 (영문/숫자/하이픈, DB 저장 키로 사용되므로 한 번 정하면 변경 비권장)
- `type`: `"channel"` (#) 또는 `"dm"` (@)
- `label`: 사이드바에 표시할 이름
- `desc`: 상단 topbar에 표시할 설명

config.json 저장 시 열려 있는 브라우저에 즉시 반영됩니다.

---

## 여러 PC에서 공유

서버 PC의 IP로 접속:
```
http://<서버-IP>:3000
```

---

## 삭제 방법

| 대상 | 방법 |
|------|------|
| 메시지 전체 | `Shift + 클릭` (메시지 본문) |
| 첨부 이미지 | `Shift + 클릭` (이미지) |
| 첨부 파일 | `Shift + 클릭` (파일 카드) |

Shift를 누르면 화면 하단에 경고 힌트가 표시됩니다.

---

## 파일 구조

```
void-chat/
├── server.js        # Express + SQLite + WebSocket
├── config.json      # 허용 IP / 이름 맵 / 포트 / 파일 크기 제한
├── public/
│   ├── index.html   # 프론트엔드
│   └── favicon.svg  # 파비콘
├── uploads/         # 업로드 파일 (자동 생성)
├── void.db          # SQLite DB (자동 생성)
└── package.json
```
