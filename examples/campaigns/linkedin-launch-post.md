---
id: postflight-linkedin-launch
title: PostFlight launch post
campaign: postflight-launch
targets: [linkedin]
hashtags: [OpenSource, SocialMedia, DevTools]
sponsored: false
aiGenerated: false
---
Pressing Enter twice on LinkedIn can cost you your hook.
Blank lines eat a full visible line on mobile, and you only get three before the "...more" cut.
Most of us never see it, because we write on desktop and everyone reads on a phone.
I kept hitting problems like that, so I built a linter for them.
PostFlight checks a draft before you publish it. It is open source, MIT, and runs entirely on your machine with no API keys and no account.
It catches 77 things across 9 platforms. A few that surprised me:
Instagram's profile grid moved to 3:4 and slices 34px off each side of a 4:5 post, but the Graph API rejects 3:4 uploads outright.
Bluesky's image cap is 2,000,000 bytes, not 2 MiB. Files between the two fail silently.
A YouTube Short in landscape is quietly filed as a normal video and never reaches the Shorts shelf.
Open Graph images over 300KB vanish on WhatsApp, which is where a lot of link sharing actually happens.
Pasting bold text from Google Docs breaks screen readers and hides your keywords from search.
The part I did not expect: while writing the docs I found my own README was wrong. It claimed 30 rules. The engine had 77, and 40 of them were not registered properly, so they showed up in CI as raw error codes with no explanation. Fixing that was the most useful thing I did all week.
There is a test now that fails the build if the docs and the code ever disagree again.
It is day two and the repo is open for contributions. Platform limits change every quarter, so a spec update is a two-minute PR and genuinely helps. There are 10 issues tagged good first issue with the exact files to touch.
Link in the comments. Happy to answer anything here.
#OpenSource #SocialMedia #DevTools
