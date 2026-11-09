# Security Policy

## Reporting a vulnerability

Please report security issues privately by email to **security@ugurlabs.com**. Do not open a public GitHub issue, pull request or discussion for a security problem.

Please include:

- Which server is affected (`sched-mcp-server` or `sessionize-mcp-server`) and its version
- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Any suggested fix, if you have one

Never include real API keys, Sessionize endpoint IDs or personal data in a report. Use placeholder or test values instead.

## What to expect

- We aim to acknowledge your report within 5 business days.
- We will keep you updated while we investigate and fix the issue.
- Once a fix is released, we are happy to credit you in the release notes, unless you prefer to stay anonymous.

Please give us a reasonable amount of time to release a fix before disclosing the issue publicly.

## Supported versions

Security fixes are made for the latest released version of each server on npm. Please update to the latest version before reporting.

## Scope

In scope:

- The code in this repository and the packages published from it (`@ugurlabs/sched-mcp-server` and `@ugurlabs/sessionize-mcp-server`)
- For example: leaking API keys or endpoint IDs, write tools reachable with read-only access, path traversal in the export tool, or unsafe downloads

Out of scope:

- Vulnerabilities in Sched or Sessionize themselves. Please report those to the vendors directly.
- Issues that require an attacker to already control your machine or your MCP client configuration
- Exposure caused by sharing your own API key or endpoint ID

## Good faith research

We will not take action against anyone who reports a vulnerability in good faith, follows this policy, and avoids harming other people's events or data. Only test against Sched events and Sessionize events that you own or are allowed to test.
