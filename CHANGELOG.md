# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A login page in front of everything. Accounts are handed out by the
  operator — `npm run ops -- adduser <name> <password>` — with no sign-up, so
  the app no longer needs Cloudflare Access (or any proxy) to stay private.
  `passwd` and `deluser` sign that person out everywhere, open chats included.

## [0.1.0] - 2026-09-16

### Added

- The app version in the room navbar is now a link — clicking it opens this
  changelog on GitHub in a new tab.
- This changelog. Versions before 0.1.0 were tracked only in commit messages.

### Fixed

- The lobby's server stats modal showed no real data: room and user counts sat
  at zero, uptime at `0m`, and the version read `[object Object]`. It was
  reading every figure from the wrong endpoint.
