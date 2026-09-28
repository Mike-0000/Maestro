import { Collapsible } from '@emdash/ui/react/primitives';
import type { ReactNode } from 'react';

const INSTALL_SSHD = [
  'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
  'Start-Service sshd',
  'Set-Service -Name sshd -StartupType Automatic',
].join('\n');

const FIREWALL_RULE = [
  'Get-NetFirewallRule -Name OpenSSH-Server-In-TCP',
  '# Only if the rule is missing:',
  "New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName 'OpenSSH Server (sshd)' " +
    '-Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22',
].join('\n');

const ADMIN_KEYS_ACL =
  'icacls.exe "$env:ProgramData\\ssh\\administrators_authorized_keys" ' +
  '/inheritance:r /grant "*S-1-5-32-544:F" /grant "SYSTEM:F"';

const CLIENT_CHECKS = [
  'Test-NetConnection <host> -Port 22   # Windows',
  'nc -vz <host> 22                     # macOS or Linux',
  'ssh <user>@<host>',
].join('\n');

/**
 * Explains what a Windows machine needs before Maestro can use it. Maestro never changes the remote
 * machine's services, firewall, or keys, so these steps are the user's to run there.
 */
export function WindowsHostSetupHelp({ defaultOpen = false }: { defaultOpen?: boolean }) {
  return (
    <Collapsible.Root defaultOpen={defaultOpen}>
      <div className="w-fit">
        <Collapsible.Trigger type="button">Connecting to a Windows machine?</Collapsible.Trigger>
      </div>
      <Collapsible.Panel className="grid gap-3 pt-2 text-sm">
        <p className="text-foreground-muted">
          Maestro connects to Windows 10 1809, Windows Server 2019, or later through the built-in
          OpenSSH Server. It does not install or configure SSH on the remote machine for you.
        </p>
        <Section title="1. On the Windows machine, in PowerShell as Administrator">
          <Step text="Install OpenSSH Server, start it, and start it automatically after a reboot:">
            <Code>{INSTALL_SSHD}</Code>
          </Step>
          <Step text="Check that the firewall allows inbound TCP port 22. Installing OpenSSH Server normally adds this rule.">
            <Code>{FIREWALL_RULE}</Code>
          </Step>
          <Step text="Authorize your public key (never copy the private key). For a standard account, add it to C:\Users\<you>\.ssh\authorized_keys. For an account in the Administrators group, Windows only reads C:\ProgramData\ssh\administrators_authorized_keys, which must be restricted to Administrators and SYSTEM:">
            <Code>{ADMIN_KEYS_ACL}</Code>
          </Step>
          <Step text="Install Git for Windows so SSH sessions find git.exe on the PATH." />
          <Step text="PowerShell must run in FullLanguage mode for this account (AppLocker or WDAC can restrict it), and a Group Policy execution policy of AllSigned blocks the Maestro installer script. Workspace previews also need AllowTcpForwarding, which sshd enables by default." />
        </Section>
        <Section title="2. From this computer">
          <Step text="Confirm the machine is reachable and that key authentication works without a password prompt:">
            <Code>{CLIENT_CHECKS}</Code>
          </Step>
        </Section>
        <Section title="3. In Maestro">
          <Step text="Add the host with the same user and key, then choose Test Connection. Maestro detects Windows and lists anything missing. On first connect it installs its workspace server under %USERPROFILE%\.emdash on that machine; no administrator rights are needed." />
        </Section>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h4 className="font-medium">{title}</h4>
      <ul className="grid gap-2 pl-0">{children}</ul>
    </section>
  );
}

function Step({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <li className="grid list-none gap-1">
      <span className="text-foreground-muted">{text}</span>
      {children}
    </li>
  );
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-muted overflow-x-auto rounded px-2 py-1.5 text-xs whitespace-pre select-text">
      {children}
    </pre>
  );
}
