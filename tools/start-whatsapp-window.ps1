# Starts the dedicated WhatsApp Web window on its own saved profile, if it is not already running. Debug port is bound to this PC only.
$prof = 'C:\Users\danieltekyi\AppData\Local\ms-playwright\wa-tereflow-profile'
$running = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match 'wa-tereflow-profile' -and $_.CommandLine -notmatch '--type=' }
if (-not $running) {
  Start-Process -FilePath 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' -ArgumentList '--remote-debugging-port=9444','--remote-debugging-address=127.0.0.1',"--user-data-dir=$prof",'--no-first-run','--window-position=-2000,0','https://web.whatsapp.com/'
}
