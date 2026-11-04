# On your phone

Open MPT on a phone and you get the **phone view** (`/m`): a quick way to check on the
team, not the whole app. Four tabs along the bottom:

- **Team** — the [Welcome checklist](00-getting-started.md#the-welcome-checklist)
  while the team is new (spawning is left to the full UI), then your teammates (what each is working on, its model, context fill, and
  cost), then the queue: at risk, waiting, working, with **Force-fail** /
  **Re-enqueue** / **Cancel**. Tap a teammate to watch it live, or **Pair** (see
  [Teammates](03-teammates.md#pairing-with-a-teammate)). The tab gets an amber dot
  when something is at risk.
- **Chat** — the assistant chat, with history. On a phone **Enter starts a new
  line**; tap ➤ to send. The tab shows how many replies you haven't read.
- **Thoughts** — your notes as a list, in their folders, with search. Tap one to read
  it (checklists are tappable), ✏️ to write (it saves as you type), and change its
  color, pin, archive, or delete it. **+ Note** starts a new one.
- **Inbox** — finished work. Tap a row to read its summary right there (that marks it
  read); **Open full** goes to the task's page in the full UI.

An empty tab says what goes there, as in the full UI: Team explains the assistant and offers
**Start the assistant** (so does Chat, while no one is there to answer), and the Queue, Thoughts and Inbox offer **Ask the
assistant**, which switches to Chat with the cursor in the box (or **New note** on
Thoughts). **Learn more** opens the matching page of this guide.

The strip under the header is the queue summary, and ⏸ shows when distribution is
paused. **?** opens this guide (`/m/help`) at this page, with its topics and search
under a **Contents** button; a bottom tab takes you back. 🖥 switches this device to the full UI, and it stays there until you open
`/m` again. Boards, tasks, schedules, workflows, team size, and config are only in the
full UI (so the [Work items](08-configuration.md#work-items-feature-toggles) toggles
don't change the phone view; **Open full** on an item of a switched-off kind shows the
"turned off" notice).

## Getting to it from your phone

MPT listens only on the machine it runs on. To reach it from a phone, put a tunnel in
front of it that handles login (for example, an SSO-protected tunnel service your
company provides), and open its URL in a browser that can sign in to it. Set an API
token too: the phone asks for it once.
