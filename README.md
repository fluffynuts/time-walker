time-walker
---
walk through time trying to satisfy your current dependency semvers with the 
available package at the time to track down why it has stopped working

usage
---

`npx time-walker --at "1 week ago"`

will attempt to:
- clear out your current node_modules
- install dev and prod dependencies that satisfy your semvers as at a week ago

see `npx time-walker --help` for more info.
