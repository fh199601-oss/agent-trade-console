param([ValidateSet('backup','import','confirm-export','show')][string]$Action,[string]$Address)
$ErrorActionPreference = 'Stop'
if (($Action -ne 'import' -or $Address) -and $Address -notmatch '^0x[0-9a-fA-F]{40}$') { exit 1 }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
if ($Action -eq 'confirm-export') {
 $answer = [Windows.Forms.MessageBox]::Show("$Address  即将在本机显示这个触发钱包的明文私钥。持有私钥的人可以转走其中的资产。继续显示？",'交易台 · 导出私钥','YesNo','Warning','Button2')
 if ($answer -eq 'Yes') { '{"confirmed":true}' } else { '{"cancelled":true}' }
 return
}
if ($Action -in @('import','show')) {
 $show = $Action -eq 'show'
 $form = New-Object Windows.Forms.Form
 $form.ClientSize = New-Object Drawing.Size(540,155)
 $form.StartPosition = 'CenterScreen'
 $form.TopMost = $true
 $label = New-Object Windows.Forms.Label
 $label.SetBounds(12,12,515,46)
 $box = New-Object Windows.Forms.TextBox
 $box.SetBounds(12,64,510,28)
 $ok = New-Object Windows.Forms.Button
 $ok.SetBounds(398,106,125,28)
 $ok.DialogResult = 'OK'
 if ($show) {
  $form.Text = '交易台 · 触发钱包私钥'
  $label.Text = "$Address  复制下方 64 位通用 EVM 私钥，在 OKX Wallet 等钱包中选择「私钥导入」。60 秒后关闭。"
  $key = [Console]::In.ReadToEnd()
  if ($key -notmatch '^[0-9a-fA-F]{64}$') { exit 1 }
  $box.ReadOnly = $true
  $box.Text = $key
  $ok.Text = '关闭'
  $timer = New-Object Windows.Forms.Timer
  $timer.Interval = 60000
  $timer.Add_Tick({ $form.Close() })
  $timer.Start()
 } else {
  $form.Text = '交易台 · 导入私钥'
  $label.Text = '粘贴要用作触发端的钱包私钥，系统将自动推导地址并保存在本机。 '+$Address
  $box.UseSystemPasswordChar = $true
  $ok.Text = '导入'
  $cancel = New-Object Windows.Forms.Button
  $cancel.SetBounds(260,106,120,28)
  $cancel.Text = '取消'
  $cancel.DialogResult = 'Cancel'
  $form.CancelButton = $cancel
  $form.Controls.Add($cancel)
 }
 $form.Controls.AddRange(@($label,$box,$ok))
 $form.AcceptButton = $ok
 $result = $form.ShowDialog()
 if ($show) { $timer.Dispose(); '{"shown":true}' }
 elseif ($result -eq 'OK') { [Console]::Write((@{key=$box.Text} | ConvertTo-Json -Compress)) }
 else { '{"cancelled":true}' }
 $form.Dispose()
 return
}
$form = New-Object Windows.Forms.Form
$form.Text = '交易台 · 导出加密密钥'
$form.ClientSize = New-Object Drawing.Size(490,190)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$text = New-Object Windows.Forms.Label
$text.SetBounds(12,12,470,45)
$text.Text = "触发钱包 $Address：设置备份密码（至少 12 个字符），并再输入一次。"
$form.Controls.Add($text)
$inputs = foreach ($y in 60,95) {
 $box = New-Object Windows.Forms.TextBox
 $box.SetBounds(12,$y,450,28)
 $box.UseSystemPasswordChar = $true
 $form.Controls.Add($box)
 $box
}
$save = New-Object Windows.Forms.Button
$save.Text = '选择保存位置'
$save.SetBounds(215,140,135,30)
$save.DialogResult = 'OK'
$cancel = New-Object Windows.Forms.Button
$cancel.Text = '取消'
$cancel.SetBounds(360,140,100,30)
$cancel.DialogResult = 'Cancel'
$form.Controls.AddRange(@($save,$cancel))
$form.AcceptButton = $save
$form.CancelButton = $cancel
if ($form.ShowDialog() -ne 'OK') { '{"cancelled":true}'; return }
$password = $inputs[0].Text
if ($password.Length -lt 12 -or $password.Length -gt 1024) { '{"error":"length"}'; return }
if ($password -cne $inputs[1].Text) { '{"error":"mismatch"}'; return }
$dialog = New-Object Windows.Forms.SaveFileDialog
$dialog.Filter = 'Encrypted Keystore (*.json)|*.json'
$dialog.FileName = "trigger-$Address.json"
if ($dialog.ShowDialog() -ne 'OK') { '{"cancelled":true}'; return }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::Write((@{file=$dialog.FileName;password=$password} | ConvertTo-Json -Compress))
