"""Output-token split per agent round (src/agent_loop._split_round_output)."""

from src.agent_loop import _split_round_output


def test_backend_reasoning_count_wins():
    s = _split_round_output(100, "x" * 10, "y" * 30, [{"name": "t", "arguments": "z" * 9}], 60)
    assert s == {"reasoning": 60, "answer": 30, "tool_calls": 10, "source": "backend"}


def test_proportional_split_by_streamed_text():
    s = _split_round_output(100, "x" * 300, "y" * 100, [])
    assert s == {"reasoning": 75, "answer": 25, "tool_calls": 0, "source": "proportional"}


def test_estimate_without_real_usage():
    s = _split_round_output(0, "x" * 40, "y" * 8, [{"name": "ab", "arguments": "cd"}])
    assert s == {"reasoning": 10, "answer": 2, "tool_calls": 1, "source": "estimated"}


def test_parts_always_sum_to_output():
    for reasoning, answer, args in [(1, 1, 1), (7, 3, 5), (0, 0, 9), (999, 1, 0)]:
        s = _split_round_output(37, "r" * reasoning, "a" * answer, [{"name": "", "arguments": "t" * args}])
        assert s["reasoning"] + s["answer"] + s["tool_calls"] == 37
