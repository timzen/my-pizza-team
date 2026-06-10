#!/usr/bin/env bash
# Publish script: increments the version (MAJOR, MINOR, or PATCH),
# updates deno.json, commits, creates a git tag, and pushes it.

set -euo pipefail

BUMP_TYPE="${1:-PATCH}"
BUMP_TYPE="$(echo "$BUMP_TYPE" | tr '[:lower:]' '[:upper:]')"

if [[ "$BUMP_TYPE" != "MAJOR" && "$BUMP_TYPE" != "MINOR" && "$BUMP_TYPE" != "PATCH" ]]; then
  echo "Usage: ./scripts/publish.sh [MAJOR|MINOR|PATCH]"
  echo "  Default: PATCH"
  exit 1
fi

# Get current version from deno.json
CURRENT_VERSION="$(grep -m1 '"version"' deno.json | sed 's/.*: *"\([^"]*\)".*/\1/')"

if [[ -z "$CURRENT_VERSION" ]]; then
  echo "Error: Could not read version from deno.json"
  exit 1
fi

echo "Current version: $CURRENT_VERSION"

# Split into components
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Increment based on bump type
case "$BUMP_TYPE" in
  MAJOR)
    MAJOR=$((MAJOR + 1))
    MINOR=0
    PATCH=0
    ;;
  MINOR)
    MINOR=$((MINOR + 1))
    PATCH=0
    ;;
  PATCH)
    PATCH=$((PATCH + 1))
    ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW_VERSION}"

echo "New version: $NEW_VERSION"
echo "Tag: $TAG"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag $TAG already exists"
  exit 1
fi

# Update version in deno.json
sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" deno.json

# Commit the version bump
git add deno.json
git commit -m "chore: bump version to ${NEW_VERSION}"

# Create and push the tag
git tag "$TAG"
git push origin HEAD
git push origin "$TAG"

echo ""
echo "✅ Published $TAG"
