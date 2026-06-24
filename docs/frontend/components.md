# Component catalog

The feature-level components live directly under `web/src/components/`; reusable
primitives live in `web/src/components/ui/`. Below is the map of what each top-level
component does. (For an interactive, rendered catalog, see *Storybook* at the bottom.)

## Chat surface

| Component | Role |
|-----------|------|
| `Composer.tsx` | The message input box (send, attach, model/incognito toggles) |
| `Messages.tsx` | The scrolling conversation transcript |
| `Markdown.tsx` | Renders assistant markdown (GFM, syntax highlighting) |
| `Thinking.tsx` | Renders the model's thinking/reasoning blocks |
| `ToolRow.tsx` | A single tool call/result row inside a message |
| `ContextMeter.tsx` | Live context-window usage indicator |
| `Welcome.tsx` | Empty-state / first-run welcome screen |

## Retrieval & artifacts

| Component | Role |
|-----------|------|
| `RagSources.tsx` | Shows the document passages cited by a RAG answer |
| `ArtifactsPanel.tsx` | Side panel for generated artifacts |
| `Lightbox.tsx` | Full-screen image viewer |
| `PlanCard.tsx` / `PlanPanel.tsx` | Display the agent's plan |

## Navigation & chrome

| Component | Role |
|-----------|------|
| `Sidebar.tsx` | Conversation list / navigation |
| `CommandPalette.tsx` | Keyboard-driven command launcher |
| `ModelPicker.tsx` | Model selection |
| `IncognitoToggle.tsx` | Toggle non-persisted (incognito) chat |
| `HelpDialog.tsx` | Help / shortcuts dialog |
| `ArchiveDialog.tsx` | Archive a conversation |
| `AskUser.tsx` | Inline prompt when the agent asks the user a question |

## Subdirectories

- `components/ui/` — primitives (buttons, dialogs, menus) wrapping Radix.
- `components/settings/` — the Settings dialog and its panels (models, RAG, embeddings, …).
- `components/auth/` — login / setup screens.

## Interactive catalog (Storybook)

For a live, rendered catalog you can browse and tweak in isolation, set up
[Storybook](https://storybook.js.org/) in `web/`:

```bash
cd web
pnpm dlx storybook@latest init --type react
pnpm storybook        # dev catalog at http://localhost:6006
pnpm build-storybook  # static build → web/storybook-static/
```

Write a `*.stories.tsx` file next to a component to add it to the catalog. The static
build can be deployed alongside these docs (or linked from here) so the whole UI surface
is documented in one place.
