#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\n' "$FORGEJO_GIT_USERNAME" ;;
  *) printf '%s\n' "$FORGEJO_GIT_TOKEN" ;;
esac
