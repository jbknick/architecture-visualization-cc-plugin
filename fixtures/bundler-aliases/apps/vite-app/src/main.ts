import { Button } from "@/components/Button";
import { format } from "@/lib/format";
import { card } from "~ui";
import { card as sameCard } from "~ui/card";

export const page = `${Button("go")}${format(1)}${card("a")}${sameCard("b")}`;
