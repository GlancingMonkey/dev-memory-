# Code Memory 개발 시작

실제 실행·설정·사용 방법은 [Extension README](README.md)에서 관리합니다.

1. [공통 개발 가이드](../docs/DEVELOPMENT.md)에서 DB·Backend 준비를 마칩니다.
2. Windows 로컬 VS Code에서 이 extension 폴더를 열고 의존성을 설치·빌드합니다.
3. README의 개발 호스트 실행 명령을 사용하거나 F5의 Run Extension을 실행합니다.
4. 개발 호스트에서 프로젝트 폴더와 실제 API 설정을 확인한 뒤 **Code Memory: 코드 저장**과 **Code Memory: 검색창 열기**를 사용합니다.

F5의 watch 작업은 [.vscode/extensions.json](.vscode/extensions.json)에 있는 권장 esbuild problem matcher 확장을 사용합니다. 문제 발생 시 README의 사전 빌드 후 개발 호스트 실행 방법을 따릅니다.

- 구현: [src/extension.ts](src/extension.ts), [src/sidebar.ts](src/sidebar.ts), [src/logic.ts](src/logic.ts)
- 명령·설정·빌드 스크립트: [package.json](package.json)
- [단위 테스트와 실제 연결 검증](../docs/TESTING.md)
- [시연 순서](../docs/DEMO.md)
