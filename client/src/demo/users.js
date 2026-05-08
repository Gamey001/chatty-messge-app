// Shared demo accounts so reviewers can chat between two tabs/browsers
// without provisioning users themselves. The first click on each button
// will register the account; subsequent clicks just sign in.
//
// These are intentionally low-stakes demo creds. Anyone with this code can
// log into them — do not put any real conversations through these accounts.

export const DEMO_USERS = [
  {
    username: "demo_alice",
    display_name: "Alice (demo)",
    password: "whisperbox-demo-2026!",
    color: "#00a884",
  },
  {
    username: "demo_bob",
    display_name: "Bob (demo)",
    password: "whisperbox-demo-2026!",
    color: "#06cf9c",
  },
];
