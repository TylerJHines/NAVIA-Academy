# Team View with team codes (any email account)

Team View no longer depends on a company email domain. A team is a Firestore document whose **document ID is the team code**. Anyone signed in with Google (Gmail, Outlook, a work account, any address) enters the code in Team View, a request goes to the team administrator, and the administrator approves or declines it.

## 1. Publish the new rules
Firebase Console → Firestore Database → **Rules** → paste the whole `firestore.rules` from this version → **Publish**.

## 2. Remove the TEKsystems team
Firebase Console → Firestore Database → **Data**:
1. Open `companies` → `teksystems.com`.
2. For each subcollection (`members`, and `requests` if present): open its ⋮ menu → **Delete collection**. Deleting a document does not delete its subcollections, so do these first.
3. Open the ⋮ menu of the `teksystems.com` document → **Delete document**.

People who were in that team will see the "Enter a team code" box the next time they open Team View.

## 3. Create your new team
1. Find your UID: Firebase Console → **Authentication** → **Users** → copy the **User UID** for the Google account you will use as administrator (your Gmail is fine).
2. Firestore → Data → `companies` → **Add document**:
   - Document ID: your team code, **uppercase letters, numbers and dashes, 4–40 characters**, e.g. `NAVIA-7K3Q`. Anyone with the code can *request* to join, so pick something not easy to guess.
   - Field `name` (string): the team's display name, e.g. `NAVIA Study Team`
   - Field `adminUid` (string): the UID from step 1
3. You do **not** need to create a `members` document for yourself. The first time you enter the code in Team View, the app adds your administrator row.

## 4. Deploy and test
Upload the changed files to GitHub Pages, then:
1. Sign in with your administrator account → Team View → enter the code → you see the dashboard and **Team code to share**.
2. Sign in with another account (any email) → enter the code → "pending administrator approval".
3. Back as administrator → **Refresh team** → **Approve**. The member refreshes and sees the team.
4. Members can **Leave team**; pending users can **Cancel request**; the administrator can **Remove** members and **Switch team**.

## Notes
- The code is the join key, not a password: a request is all it gets someone. Your approval decides who sees the team.
- To make another team, add another `companies/<CODE>` document. Each account is in one team at a time.
- To change a team's administrator, change `adminUid` on its document.
