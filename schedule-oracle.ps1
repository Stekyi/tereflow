$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -Command `"cd '$here\oracle'; `$env:PYTHONPATH='.'; python -m tereflow_oracle ingest`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 3am
Register-ScheduledTask -TaskName "Tereflow Oracle ingest" -Action $action -Trigger $trigger -Force
