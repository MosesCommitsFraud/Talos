"""Regression tests for persisted conversation context ordering."""

from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from core.database import Base
from core.database import ChatMessage as DbChatMessage
from core.database import Session as DbSession
from core.session_manager import SessionManager


def test_cold_load_preserves_question_before_short_answer(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path / 'history.db'}")
    Base.metadata.create_all(engine)
    db = sessionmaker(bind=engine)()
    try:
        session = DbSession(
            id="chat-1",
            name="Test",
            endpoint_url="http://localhost",
            model="test-model",
            message_count=3,
        )
        db.add(session)

        started = datetime(2026, 7, 23, 12, 0, 0)
        # Insert deliberately out of order, as relationship/database iteration
        # order is not a chronology guarantee.
        db.add_all(
            [
                DbChatMessage(
                    id="3",
                    session_id=session.id,
                    role="user",
                    content="a",
                    timestamp=started + timedelta(seconds=2),
                ),
                DbChatMessage(
                    id="1",
                    session_id=session.id,
                    role="user",
                    content="Which approach should I use?",
                    timestamp=started,
                ),
                DbChatMessage(
                    id="2",
                    session_id=session.id,
                    role="assistant",
                    content="Choose A, B, or C.",
                    timestamp=started + timedelta(seconds=1),
                ),
            ]
        )
        db.commit()

        loaded = SessionManager.__new__(SessionManager)._db_to_session(session, db)

        assert [(m.role, m.content) for m in loaded.history] == [
            ("user", "Which approach should I use?"),
            ("assistant", "Choose A, B, or C."),
            ("user", "a"),
        ]
        assert loaded.get_context_messages()[-2:] == [
            {
                "role": "assistant",
                "content": "Choose A, B, or C.",
                "metadata": {
                    "_db_id": "2",
                    "timestamp": "2026-07-23T12:00:01Z",
                },
            },
            {
                "role": "user",
                "content": "a",
                "metadata": {
                    "_db_id": "3",
                    "timestamp": "2026-07-23T12:00:02Z",
                },
            },
        ]
    finally:
        db.close()
        engine.dispose()
