// Sample process notes used to fill an empty library (mirrors demo_data.py).
export const DEMO_SOPS = [
  {
    "id": "demo-refund",
    "owner": "Support team",
    "title": "Issue a customer refund",
    "context": "For new customer-support agents. Payments run on Stripe, tickets live in Zendesk.",
    "notes": "refund process (support) - how we do it\n- customer emails / zendesk ticket says they were charged wrong or want money back\n- check ticket: need order id or the email they paid with. if missing reply with macro \"Need order details\" and wait\n- log in to stripe dashboard (use support role, NOT admin)\n- payments tab on left -> search by customer email\n- find the right charge, check date + amount match what customer says. if 2 charges same amount same day = duplicate\n- click the charge -> Refund button top right\n- full refund if duplicate or never delivered. partial if partial delivery - amount needs approval from team lead if over $200 (ping in #support-leads slack)\n- reason dropdown: duplicate / fraudulent / requested_by_customer\n- IMPORTANT paste zendesk ticket id into the refund note so finance can reconcile, people forget this all the time\n- confirm. stripe shows \"refund pending\"\n- go back to zendesk, reply with macro \"Refund issued\" (tells them 5-10 business days), set ticket to Solved\n- if the charge is older than 90 days you cant refund in stripe -> escalate to finance@ instead\ntakes like 5 min, most time is spent searching for the charge and copying the ticket id across"
  },
  {
    "id": "demo-it-onboarding",
    "owner": "IT team",
    "title": "Set up IT accounts for a new hire",
    "context": "For IT admins. We use Google Workspace, Slack and 1Password. Laptops are managed in Jamf.",
    "notes": "new joiner IT setup - do this 2 days before start date\n1. HR sends the new hire form (name, role, team, manager, start date, personal email)\n2. google admin console -> users -> add new user. format firstname.lastname@company. put in the right org unit for their team (sales/eng/ops) - wrong OU = wrong policies!!\n3. set temp password, tick \"ask for password change at next sign in\". don't email password to work email (they can't access it yet) - send to personal email via the 1password share link instead\n4. add to groups: all-staff@ + team group (eng@ etc)\n5. slack: invite with the new google email, add to #general #announcements + team channel. manager usually tells you extra channels\n6. 1password: invite to company account, add to team vault\n7. jamf: assign laptop serial to the user, check that the prestage enrollment profile is set. laptop ships to home address from HR form\n8. send the welcome email template to personal email with: login instructions, 1password link, laptop tracking number\n9. tick off in the onboarding tracker sheet + tell manager it's done\nusual problems: forgetting org unit, people missing team slack channels, laptop shipped late. whole thing ~25 min per person and we do 5-10 a month"
  },
  {
    "id": "demo-sales-report",
    "owner": "Sales ops",
    "title": "Prepare the weekly sales pipeline report",
    "context": "For sales operations analysts. CRM is HubSpot; the report goes to leadership every Monday 10am.",
    "notes": "weekly pipeline report - every monday before 10am leadership call\n- hubspot -> reports -> saved report \"Pipeline by stage - this quarter\". set date filter to quarter to date\n- export to csv (actions -> export). takes a min to arrive by email\n- open google sheet \"Weekly Pipeline Master\", new tab named with the date e.g. 2026-10-12, paste csv\n- fix the deal owner names column, export has user IDs for people who left - lookup tab maps ids to names\n- pivot: total amount by stage and by owner. compare with last week's tab, add a WoW change column\n- flag deals stuck in same stage > 30 days (filter on \"days in stage\") - highlight red\n- copy the summary table + 3 bullet commentary (biggest movers, at-risk deals, forecast vs target) into the leadership slack #leadership-weekly\n- always double check closed won total matches hubspot dashboard, the export sometimes double counts deals with 2 line items\nthis takes 45 min to 1 hr every week, mostly copy pasting and fixing names"
  }
];
