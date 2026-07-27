# src/constants.py
"""Application-wide constants and configuration values."""

import os

# Which build is actually running. All three are baked in as ENV by the
# Dockerfile from CI's --build-arg.
#
# APP_VERSION is NOT hand-maintained: on a release build CI passes the git tag
# ("v0.2.0"), and everything else — main builds, local builds, running from
# source — reports "dev". Keeping it out of the source tree means cutting a
# release is just creating the release, with no version literal to bump, no
# ordering rule between the bump and the tag, and nothing that can drift out of
# sync with the tag it claims to be.
#
# The "v" prefix is deliberate: GitHub's releases API returns tag_name the same
# way, so the update check compares the two strings directly.
APP_VERSION = os.getenv("TALOS_VERSION", "dev")
BUILD_HASH = os.getenv("TALOS_BUILD_HASH", "dev-build")
IMAGE_TAG = os.getenv("TALOS_IMAGE_TAG", "dev")

# A build that didn't come from a release tag. Such a build has no meaningful
# version to compare, so the UI reports it as a development build instead of
# claiming it's out of date against every release.
IS_DEV_BUILD = not APP_VERSION.startswith("v")

# Update check: compares APP_VERSION against the newest GitHub release tag.
# On by default, but a deployment with no outbound internet (or an admin who
# doesn't want the app calling home at all) turns it off with
# TALOS_UPDATE_CHECK=false and the endpoint stops reaching out entirely.
UPDATE_CHECK_ENABLED = os.getenv("TALOS_UPDATE_CHECK", "true").strip().lower() not in (
    "false",
    "0",
    "no",
)
UPDATE_CHECK_REPO = os.getenv("TALOS_UPDATE_CHECK_REPO", "MosesCommitsFraud/Talos")

# Base paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) + "/"
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.path.join(BASE_DIR, "data")

# Data file paths
SESSIONS_FILE = os.path.join(DATA_DIR, "sessions.json")
PERSONAL_DIR = os.path.join(DATA_DIR, "personal_docs")
RUNBOOK_DIR = os.path.join(PERSONAL_DIR, "runbook")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
FEATURES_FILE = os.path.join(DATA_DIR, "features.json")
SETTINGS_FILE = os.path.join(DATA_DIR, "settings.json")

# API Configuration
MAX_CONTEXT_MESSAGES = 90
REQUEST_TIMEOUT = 20
OPENAI_COMPAT_PATH = "/v1/chat/completions"

# Environment variables with defaults
DEFAULT_HOST = os.getenv("LLM_HOST", "localhost")
LLM_HOSTS = [h.strip() for h in os.getenv("LLM_HOSTS", "").split(",") if h.strip()]
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")


# Cleanup configuration
CLEANUP_ENABLED = os.getenv("CLEANUP_ENABLED", "True").lower() == "true"
CLEANUP_INTERVAL_HOURS = int(os.getenv("CLEANUP_INTERVAL_HOURS", "24"))

# Default parameters
DEFAULT_TEMPERATURE = 1.0
DEFAULT_MAX_TOKENS = 0
