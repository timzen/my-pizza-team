## On Enter

Generate a diff of your changes and upload it for the lead to review.

1. Write the diff to a temp file: `git diff main -- . > /tmp/changes.diff`
2. Use the `upload_attachment` tool with `filePath: "/tmp/changes.diff"` and `filename: "changes.diff"`
3. Include a brief summary of what changed in the message

The lead will review your diff with inline comments and send you consolidated feedback.

## Exit Criteria

- Diff uploaded for lead review
- All review comments addressed (if any)
- Tests passing

## On Exit

Summarize what was accomplished in the task result.
