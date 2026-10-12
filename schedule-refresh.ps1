$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$here\run-refresh.cmd`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 4)
Register-ScheduledTask -TaskName "Tereflow daily refresh" -Action $action -Trigger $trigger -Settings $settings -Force
