# Security policy

rewindbug records what happens in a user's browser before an error: the DOM, typed input, console and network. A flaw in it can leak personal data or secrets into a bug report, so reports of such flaws are welcome.

## Supported versions

Only the latest release on npm gets fixes. Version 0.x has no long-lived branches.

## Reporting a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/bybraveHQ/rewindbug/security/advisories/new). Do not open a public issue for a vulnerability.

Include the version, what data leaks or what an attacker can do, and a page or a report that shows it. You will get an answer within seven days. A fix ships as a patch release with a note in the CHANGELOG and, when it matters to users, a GitHub security advisory that credits you unless you ask otherwise.

## What counts

- Data the defaults promise to mask or leave out ends up in a report: passwords, masked fields, hidden inputs, CSRF tokens, request bodies outside `bodyAllowlist`, query parameters the default filter masks. The full list is in the README under Privacy.
- A page can run code in the report viewer, the generated Playwright test or the MCP server through content it controls.
- The example endpoint or the MCP package lets a request without the token read or write reports.

## What does not count

- Data the README lists as kept by default, such as page text, console messages or `data-*` attributes. The README says how to mask or drop it.
- Gaps listed under "Known gaps" in the README.
- Vulnerabilities in dependencies with no path through rewindbug; report those upstream.
