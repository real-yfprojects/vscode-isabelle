# While Isabelle checks

The first start loads the HOL image, which takes a few seconds up to a minute.

The status bar item on the right names the session and what the prover is doing.
Clicking it picks the session; its tooltip has the rest.

| Icon | Meaning |
|---|---|
| spinning | starting, or checking |
| books | ready; `3/4` counts the theories that are done |
| red | the server failed; its tooltip links to the log |

Isabelle checks the theory from the top down to 50 lines below the cursor, and
re-checks as you type. Errors are squiggles and are listed in the **Problems** view.
