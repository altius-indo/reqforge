---
id: code-components
title: Code components
tabs: components
keywords: component, code, checkout, path, globs, repository, language, tag mode, owners, story component, trace tags
---
A **component** is a code checkout — a service, module or package — whose source files carry trace tags. Stories name
the component that delivers them, and the Verification tab scans components for tags.

### Add a component

1. Open the **Components** tab and click **New**.
2. Fill in **title** and **key** (lower-case letters, digits, `.`, `_` or `-`, for example `web`). Stories refer to the
   component by this key.
3. Set **path** to the local checkout, absolute or relative to the requirements repository, and optionally
   **repo_url**.
4. Set **globs** (comma-separated) to choose which files to scan, for example `src/**, tests/**`.
5. Choose **tag_mode**: *auto* also counts requirement ids that appear in test files; *explicit* counts only
   `reqforge: implements` and `reqforge: verifies` comments, for code that mentions ids as data.
6. Click **Create**.

### Tag code and tests

1. Above the code that implements a requirement, add a comment `reqforge: implements` followed by the requirement id.
2. Above a test, add `reqforge: verifies` followed by the criterion, written as the requirement id, `#` and the
   criterion id, or put the criterion in the test's name.
3. Open the **Verification** tab and click **Scan now** to pick up the tags.

### Link stories to a component

1. Open a story in the drawer.
2. In the **component** field, pick one of the suggested component keys. A warning appears if the key is not a defined
   component.
3. Click **Save**.
