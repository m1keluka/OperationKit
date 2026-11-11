# Sample files for trying file import

These four files belong to a made-up small business, **Cedar & Pine Home Services**. It does
home cleaning and handyman work in the made-up town of Millbrook and has about 14 staff. The
owner is Rosa Delgado. Every person, client, address, price, phone number and email address in
these files is invented. If one looks like a real business, that's a coincidence. Upload the
files to see how file import works before you use your own documents.

## What's in here

- **Price List 2025 - FINAL v3.xlsx**: a spreadsheet with five tabs (Cleaning, Handyman, Add-ons,
  OLD 2024 prices, Commercial (draft)). It's messy on purpose, like most real price lists: the
  column names change from tab to tab, prices are written in different ways ($289, 289.00,
  "45 USD"), the same service has two names ("Deep Clean" and "Deep-clean (whole home)"), and
  there's an old tab nobody deleted.
- **Customer Policies - Cancellations, Refunds and Guarantees.pdf**: the 3-page policy that
  customers get. It covers booking, cancellations, refunds, the re-clean guarantee, damage,
  pets and payment.
- **Team meeting transcript - 2025-03-04.txt**: the written record of a weekly staff meeting
  where the team decides on some changes. It ends with a list of who is doing what.
- **SOP - New Client Onboarding.docx**: a Word document that sets out, step by step, how the
  team takes a new client from first phone call to follow-up call.

## The files disagree on purpose

Real business documents go out of date, so these files contradict each other in three places.
A good answer should notice this and say which file says what.

| Topic | One file says | Another file says |
| --- | --- | --- |
| Deep Clean price | **$289**, effective 1/6/2025 (price list, Cleaning tab) | **$320** for new bookings from April 1 (team meeting) |
| Cancellations | **24 hours** notice, **$40** late fee (customer policies PDF) | **48 hours** notice, **$50** late fee from April 1 (team meeting) |
| Quote turnaround | **2 business days** (customer policies PDF) | **1 business day** (onboarding SOP) |

## Good questions to try

1. "How much is a deep clean?"
2. "What happens if a customer cancels the day before?"
3. "Where are we with Maple Street Dental, and who is responsible for the next step?"

## Rebuilding the files

The files are made by a script, so they come out exactly the same every time. To rebuild them,
go to the `app/server` folder and run:

```
npx tsx src/scripts/make-sample-business-files.ts
```
