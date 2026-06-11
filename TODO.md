# TODO

General ideas I have and want to implement

## General

- Logging
    - this will surely vary by operating system
    - basic logging 
    - agent interactions, what they asked for, what they got
- Error dialogs, currently some API calls will 4xx or 5xx and you have to go digging in the networking tab of the console to find the error message. A uniform error handling dialog would be nice (at least while I'm developing)

## Workflow

- Remove the default and make it explicitly chosen per story
- One shot templates! Kind of like reusable stories for a single task, that task when done gets archived to the common story. I think an iconic one would be a "research workflow" that has instructions on the tools to use for gathering data, a step to compile all the notes, and another to produce a report. I just want to say "go research this" and let the task go without having to make a whole new story with a single task. Alternative example is a one shot to draft an email or message.

## Home UI

- Agent interaction viewer
    - Like a mini demo
    - Has a sample workflow with instructions
    - Has a sample story with tasks
    - There is a step forward/backwards button
    - It uses the actual APIs and renders the request/responses 
    - Let's the user see how an agent consumes work and what data it gets when it does

## Workflow UI

- Move edit to a dialog? Just the states/transitions; instructions and default categories remain always visible

## Board UI

- Click to just view the unread comments
- Increase the width of the Story/Task modals
- Pause button on the story
- Change story workflow (wizard like help to change status of existing stories, reloads ui)
- The state left/right buttons should only be clickable if there is a valid transition
- The state left/right buttons should handle multiple options (modal? dropdown?)
- The backlog button should hide when all the tasks are done

## Agents UI

- Spawn button

## Assistant UI

- Spawn button

## Archive UI

- Artifact viewer

## Memory UI

- Add/Remove Categories

## MacOS

- Reload from disk menu item