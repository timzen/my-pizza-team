#!/usr/bin/env bash
# Publish script: sets the next version, updates deno.json (and the generated copies
# derived from it), commits, creates a git tag, and pushes it. The tag triggers the
# release workflow.
#
# Usage:
#   ./scripts/publish.sh            # PATCH bump (default)
#   ./scripts/publish.sh MINOR      # or MAJOR / PATCH
#   ./scripts/publish.sh 0.20.0     # jump straight to an explicit version

set -euo pipefail

usage() {
  echo "Usage: ./scripts/publish.sh [MAJOR|MINOR|PATCH|X.Y.Z]"
  echo "  MAJOR|MINOR|PATCH  bump that part of the current version (default: PATCH)"
  echo "  X.Y.Z              set this exact version (must be higher than the current one)"
}

ARG="${1:-PATCH}"
case "$ARG" in
  -h|--help) usage; exit 0 ;;
esac

# An explicit version (a leading "v" is tolerated, since tags carry one).
EXPLICIT_VERSION=""
BUMP_TYPE=""
if [[ "$ARG" =~ ^v?([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
  EXPLICIT_VERSION="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.${BASH_REMATCH[3]}"
else
  BUMP_TYPE="$(echo "$ARG" | tr '[:lower:]' '[:upper:]')"
  if [[ "$BUMP_TYPE" != "MAJOR" && "$BUMP_TYPE" != "MINOR" && "$BUMP_TYPE" != "PATCH" ]]; then
    echo "Error: '$ARG' is neither MAJOR/MINOR/PATCH nor a version like 0.20.0"
    usage
    exit 1
  fi
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

if [[ -n "$EXPLICIT_VERSION" ]]; then
  NEW_VERSION="$EXPLICIT_VERSION"
  # Refuse to go backwards or stand still. `mpt upgrade` installs the newest release,
  # so a lower number would be a release nobody upgrades to, and would read as a
  # downgrade to anyone who picked it by hand.
  IFS='.' read -r NMAJOR NMINOR NPATCH <<< "$NEW_VERSION"
  if (( NMAJOR < MAJOR )) \
    || (( NMAJOR == MAJOR && NMINOR < MINOR )) \
    || (( NMAJOR == MAJOR && NMINOR == MINOR && NPATCH <= PATCH )); then
    echo "Error: $NEW_VERSION is not higher than the current version $CURRENT_VERSION"
    exit 1
  fi
else
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
fi
TAG="v${NEW_VERSION}"

echo "New version: $NEW_VERSION"
echo "Tag: $TAG"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Error: Tag $TAG already exists"
  exit 1
fi

# Update version in deno.json (portable across macOS and Linux)
if [[ "$(uname)" == "Darwin" ]]; then
  sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" deno.json
else
  sed -i "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" deno.json
fi

# Propagate to the Pi extension's manifest. The daemon and the extension are one
# protocol (BATTERIES_INCLUDED.md §1.2) and must carry one version; deno.json is
# the source and harnesses/pi/package.json is a generated copy.
deno task sync-version
# Regenerate the extension's shared constants from shared/types.ts (P1c-7).
deno task sync-shared

# Commit the version bump
git add deno.json harnesses/pi/package.json harnesses/pi/src/shared/types.ts
git commit -m "chore: bump version to ${NEW_VERSION}"

# Create and push the tag
git tag "$TAG"
git push origin HEAD
git push origin "$TAG"

echo ""
echo "✅ Published $TAG"
