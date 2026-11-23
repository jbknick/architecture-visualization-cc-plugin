using Acme.Core;

namespace Acme.App;

public class ProgramTests
{
    public void RunGreets()
    {
        Program.Run(new PoliteGreeter(), "test");
    }
}
