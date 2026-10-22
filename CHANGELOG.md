# Changelog

## 1.7.0
Reorganised and checked code; same features, same vault file – an upgrade keeps your accounts and password.

Fixed
- Installing could hang in Peergos: the app no longer ships an (empty) `data/` folder.
- A failed read from Peergos no longer starts with an empty vault (the next change would have replaced your
  accounts); the app shows the error with **Try again** instead, and saves nothing until the vault is loaded.
- Issuer and account names are shown as text: names with HTML in them (e.g. from an import) could inject markup.
- "Export Unencrypted (Aegis)" now writes Aegis' real format (Aegis and ChronoNumbers can import it again;
  before, ChronoNumbers imported 0 accounts from its own export). Exports of 1.6.x still import.
- Aegis import: database version 3 groups become the account's group; encrypted Aegis exports are explained.
- Codes stay correct when the browser pauses timers (they were renewed only at the exact second of a new period).
- Turning the password on or off no longer starts a second timer each time.
- Importing an encrypted vault no longer copies its master-password switch into the current vault.
- Creating a master password can be cancelled.
- Saves are serialized with a time limit and retried; a failed save is shown (click to try again) and leaving
  the app while saving asks first.
- Secret keys: spaces, dashes, lower case and padding are accepted; invalid Base32 is refused with a message instead
  of producing wrong codes. Edit checks digits (6–8) and period.
- QR scan: light-on-dark codes are read too; HOTP and Google Authenticator export codes are explained.
- The delete question showed a stray "}".

Changed
- Code split into small modules (`assets/js/`), unit, browser and end-to-end tests added.
- QR code drawing uses Project Nayuki's library unchanged (compiled from the upstream source); both third-party
  libraries are pinned by hash and their licences ship with the app.
- Footer: "by anderlejan".

## 1.6.1
- Last version before the clean-up (not on GitHub).
