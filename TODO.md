themes
scrolling während streaming bad
besseres kontextmenu
sidebar für plan öffnet sich nicht
gedanken sammeln sich in einem ding inder zsfm
gradient at the gone???
account thing needs better
cicd
docs
rag pipeline improvements
update pipeline cicd und andere die wichtig sind?
contextmeter doesnt show correct thing - even more wrong???
datatypes in artifact bar
skills like .claude

bugs found by ruff (noqa'd to keep CI green, fix later):
- use_research parsed in chat_routes.py (289, 405) but never forwarded to chat_helpers -> research mode is a no-op
- allow_bash parsed in chat_routes.py (408) but used nowhere -> bash gating not wired
- duplicate GET /sessions/archived in session_routes.py (~374 vs ~847) -> paginated/search version is dead, first one shadows it
