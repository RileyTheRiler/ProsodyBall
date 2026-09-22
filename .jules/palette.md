## 2026-07-20 - Enforcing confirmation on destructive actions
**Learning:** Destructive actions on individual list items (like deleting a recording) often bypass the global confirmation patterns implemented for "Clear All" actions.
**Action:** Always verify that item-level delete buttons include explicit confirmation dialogs (`window.confirm()`) before executing, especially in transient data lists.
