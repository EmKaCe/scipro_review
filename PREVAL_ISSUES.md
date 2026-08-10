# Pre-Evaluation issues log

This is a list compiling all issues I have found across multiple pre-evaluated assignments, additionally there are many issues when running pre-evaluation.
For example:
- No additional notes generated at all (probably need as additional step)
- KI Connect requests seem to time out, I think we need to drastically increase the timeout given the complexity of tasks
- Multiple "rubricSelections reference unknown category" issues.
- Especially in the begging of the log multiple "rubricSelections optionKey does not exist in category"

I think it makes in general more sense to consider making the LLM fill a pre-determined markdown form that basically works as a living document that the LLM gets to iterate over.
We then finally parse it all in the last step of pre-evaluation. I think LLMs will probably work best if we basically break this down into sub-tasks that always happen and make LLM generate the filled markdown form basically. Then use those artifacts for the next steps and iterations as needed. We should be able to do some good context engineering that way. I think this is mainly what still causes these issues. We try to make many things happen in few calls, despite having unlimited quotas. It makes more sense to follow a turn-based approach where we inject relevant parts of our living documents and verify that the markdown artifacts are parsable, then use this construct the actual suggestions that we can apply.

Additionally I have noticed some things:

## Code Formatting
- Ideally almost every thing should be ticked in either positive or negative ways, because the requirements are mutually exclusive to some extent. i.e. a student submission either follows PEP8 or it doesn't, names are either descriptive or they aren't etc.
- Some things, like f-strings are almost never marked, it seems like the LLMs have a clear blindspot, question is if this is an issue connected to the context engineering or needs even more adjustment

## Coding Concept
- It's fair that some things might not apply here because they might not be used

## Jupyter Notebooks
- This is also one big blindspot, this section is basically a must have. The cell structure, code cells and markdown cells have all positive, neutral and negative criteria, one of the 3 will always apply to the submission

## Academic Scholarship
- Same as jupyter notebooks

The assignment specific sections (pandas, numpy, scipy, sklearn) also have usually only one item checked at most. Again: The list is not mutually exclusive here, multiple things can be true, hence the checkboxes, not radio buttons.