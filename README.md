# VCAD Interview

Cloud CAD interview panel and test host for browser-based CAD design interviews.

## What is included

- React CAD interview panel for candidate and interviewer views.
- Basic sketching: select, line, rectangle, circle, dimensions, and constraints.
- Parametric feature tree with editable expressions.
- Preview features for extrude, revolve, add, and cut operations.
- Keycloak/OpenID Connect login using the hosted FTCInterview realm.
- Session APIs for interview creation, autosave, event logging, and submissions.
- Docker and Azure Container Apps publishing script.

The geometry engine is intentionally isolated behind `src/cad/geometryWorker.ts`.
The current implementation uses a deterministic browser-side preview engine. That
worker boundary is the place to swap in OpenCascade.js/OCCT for production-grade
B-rep generation without changing the panel API.

## Local setup

```powershell
npm.cmd install
npm.cmd run build
npm.cmd start
```

Open `http://localhost:8080`.

The default Keycloak settings point at the hosted FTCInterview realm:

```text
VCAD_AUTH_MODE=keycloak
VCAD_KEYCLOAK_BASE_URL=https://auth.superpoweredjalapenos.org
VCAD_KEYCLOAK_REALM=ftc-interview
VCAD_KEYCLOAK_CLIENT_ID=ftc-interview-web
```

For local-only UI testing without Keycloak:

```powershell
$env:VCAD_ALLOW_DEV_AUTH="true"
npm.cmd start
```

## Azure publish

The publish script builds the container in Azure Container Registry, deploys it
to Azure Container Apps, and updates the existing hosted Keycloak client with the
new app redirect URI and web origin.

```powershell
.\scripts\publish-azure.ps1
```

Useful overrides:

```powershell
.\scripts\publish-azure.ps1 -ResourceGroup ftcinterview-rg -Location eastus -NamePrefix vcad
.\scripts\publish-azure.ps1 -KeycloakBaseUrl https://auth.superpoweredjalapenos.org -KeycloakRealm ftc-interview -KeycloakClientId ftc-interview-web
```

The script prints the live test app URL and `/api/health` URL when deployment
finishes.

## Embedding

React hosts can import the panel:

```tsx
import { CadInterviewPanel } from "./src/components/CadInterviewPanel";

<CadInterviewPanel
  role="candidate"
  session={session}
  authToken={token}
  document={document}
  onDocumentChange={saveDocument}
/>
```

The test app in `src/App.tsx` shows the panel embedded twice: candidate mode and
interviewer observer mode.
