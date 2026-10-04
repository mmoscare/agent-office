# Windows command recovery validation

The owner asked to finish the Windows/Mac recovery. The extensionless Node shebang source and its regression test were already recovered from c089. Add a read-only Windows GitHub Actions job to execute all Windows-only cases on Windows with Node 22. It installs native dependencies in the runner and runs `node --import tsx --test tests/windows-command.test.ts`; no provider authentication, release, application restart or live worker task is involved. The job uses the existing repository checkout/setup-node major versions and `contents: read` only.

The original Mac run passed two tests and skipped six Windows-only cases. The resulting remote job, exact commit and actual result will be recorded in the task PR and private completion report. This commit only adds validation configuration and this handoff; Windows runtime results remain pending until the job finishes. No live Windows installation is changed. Both app installations retain personal.
