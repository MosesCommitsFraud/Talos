# Frontend overview

The UI in `web/` is the **only** frontend — a React 19 + Vite + TypeScript app styled
with Tailwind v4 and Radix primitives. It's built to `web/dist` and served by the
FastAPI app at `/`.

!!! info "History"
    The legacy vanilla-JS UI was removed from `main`; a snapshot lives on the `legacy`
    branch. The brand accent stays `#3d87cb` and the design intentionally avoids the
    default shadcn look.

## Stack

| Concern | Choice |
|---------|--------|
| Framework | React 19 |
| Build | Vite |
| Language | TypeScript |
| Styling | Tailwind CSS v4 (`@tailwindcss/vite`) |
| Primitives | Radix UI (`dialog`, `dropdown-menu`, `tooltip`, `switch`, `context-menu`) |
| Server state | TanStack Query (`@tanstack/react-query`) |
| Client state | Zustand (`web/src/state/`) |
| i18n | i18next / react-i18next |
| Markdown | react-markdown + remark-gfm + rehype-highlight |
| Icons | lucide-react |

## Layout

```
web/src/
  api/          # client.ts (fetch wrapper) + types.ts (API types)
  state/        # Zustand stores: chat.ts, prefs.ts, ui.ts
  components/   # feature components + ui/ (primitives), settings/, auth/
  lib/          # helpers
  i18n/         # translations
  styles/       # Tailwind / global CSS
```

- **`api/client.ts`** is the single place API calls go through; **`api/types.ts`** holds
  the request/response types (kept in sync with the backend's Pydantic models).
- **`state/`** holds Zustand stores split by concern — chat session, user prefs, and UI.
- **`components/ui/`** are the low-level reusable primitives; the files directly under
  `components/` are feature-level pieces (Composer, Messages, Sidebar, …).

## Running it

```bash
cd web
pnpm install
pnpm dev          # Vite dev server (proxies /api to the backend)
pnpm dev:mock     # dev server against mocked API responses
pnpm build        # type-check + production build → web/dist
pnpm typecheck    # tsc -b only
```

See the [component catalog](components.md) for the main components and where they live.
