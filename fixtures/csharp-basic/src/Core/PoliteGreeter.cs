namespace Acme.Core;

public class PoliteGreeter : IGreeter
{
    public string Greet(string name) => "Good day, " + name;
}
