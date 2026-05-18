// src/data/names-list.js
//
// W370 - Reasonable subset of US Census top-frequency first + last names for
// the general privacy membrane (src/privacy-membrane.js scan() name detector).
// Not exhaustive top-1000 (we keep the file under ~16KB so the membrane stays
// JS-only with zero heavy deps), but covers the high-frequency tail well
// enough to catch most everyday names in commit messages, prompts, and seed
// rows. Per-workspace augmentation lives in privacy.proprietary_terms.
//
// Source intent: roughly the top ~500 first names (m+f mixed, US Census 2010
// public-domain) and top ~500 surnames (US Census 2010 public-domain). All
// stored capitalized as they appear in prose so the detector can match
// "Sandra Pham" without case-folding the source text.
//
// Detection contract: scan() looks for capitalized-token bigrams where the
// first token hits FIRST_NAMES and the second token hits LAST_NAMES. This
// avoids the n^2 false-positive risk of matching any single capitalized word.

export const FIRST_NAMES = Object.freeze(new Set([
  // top-frequency mixed male+female (US Census 2010 public-domain, alphabetized)
  'Aaron','Abigail','Adam','Adrian','Aiden','Alan','Albert','Alex','Alexander','Alexis',
  'Alice','Alicia','Allison','Amanda','Amber','Amelia','Amy','Andrea','Andrew','Angela',
  'Anna','Anthony','Antonio','Ariana','Arthur','Ashley','Aubrey','Audrey','Austin','Autumn',
  'Ava','Avery','Barbara','Beatrice','Beau','Becky','Ben','Benjamin','Bernard','Beth',
  'Betty','Beverly','Bill','Billy','Blake','Bonnie','Brad','Bradley','Brandon','Brenda',
  'Brendan','Brian','Brianna','Brittany','Brooke','Bruce','Bryan','Cameron','Camila','Carl',
  'Carlos','Carmen','Carol','Carolyn','Carrie','Carson','Casey','Catherine','Cecilia','Chad',
  'Charles','Charlie','Charlotte','Chase','Chelsea','Cheryl','Chloe','Chris','Christian','Christina',
  'Christine','Christopher','Cindy','Claire','Clara','Clarence','Claude','Clayton','Clifford','Clinton',
  'Cody','Colin','Colleen','Connor','Corey','Courtney','Craig','Cristina','Crystal','Curtis',
  'Cynthia','Daisy','Dale','Daniel','Danielle','Danny','Darlene','Darrell','David','Dawn',
  'Dean','Deborah','Debra','Denise','Dennis','Derek','Derrick','Diana','Diane','Dolores',
  'Dominic','Don','Donald','Donna','Doris','Dorothy','Douglas','Drew','Duane','Dustin',
  'Dylan','Earl','Ed','Eddie','Edgar','Edith','Edna','Edward','Edwin','Eileen',
  'Elaine','Eleanor','Elena','Eli','Elias','Elizabeth','Ella','Ellen','Elliot','Elsie',
  'Emily','Emma','Eric','Erica','Erik','Erin','Ernest','Esther','Ethan','Eugene',
  'Eva','Evan','Evelyn','Faith','Fernando','Florence','Floyd','Frances','Francis','Francisco',
  'Frank','Franklin','Fred','Frederick','Gabriel','Gabriella','Gail','Gary','Gavin','Gene',
  'George','Gerald','Gilbert','Gina','Gladys','Glen','Glenn','Gloria','Gordon','Grace',
  'Grant','Gregory','Hailey','Hannah','Harold','Harry','Hazel','Heather','Hector','Helen',
  'Henry','Herbert','Holly','Howard','Hugh','Hunter','Ian','Ida','Imani','Irene',
  'Iris','Isaac','Isabel','Isabella','Isaiah','Ivan','Jack','Jackson','Jacob','Jacqueline',
  'James','Jamie','Jane','Janet','Janice','Jared','Jasmine','Jason','Javier','Jay',
  'Jayden','Jean','Jeff','Jeffrey','Jenna','Jennifer','Jeremy','Jerome','Jerry','Jesse',
  'Jessica','Jill','Jim','Jimmy','Joan','Joanne','Joe','Joel','John','Johnny',
  'Jonathan','Jordan','Jorge','Jose','Joseph','Joshua','Joyce','Juan','Judith','Judy',
  'Julia','Julian','Julie','Justin','Kaitlyn','Karen','Katherine','Kathleen','Kathryn','Katie',
  'Kayla','Keith','Kelly','Kelsey','Kenneth','Kevin','Kim','Kimberly','Kristen','Kristin',
  'Kristina','Kurt','Kyle','Lance','Larry','Laura','Lauren','Lawrence','Leah','Lee',
  'Leo','Leon','Leonard','Leslie','Levi','Liam','Lillian','Lily','Linda','Lindsey',
  'Lisa','Logan','Lois','Lori','Louis','Louise','Lucas','Lucia','Lucy','Luis',
  'Luke','Lydia','Lyle','Lynn','Madeline','Madison','Manuel','Marc','Marcus','Margaret',
  'Maria','Marie','Marilyn','Mario','Marion','Mark','Marlene','Marsha','Martha','Martin',
  'Marvin','Mary','Mason','Mateo','Matthew','Maureen','Maurice','Max','Maya','Megan',
  'Melanie','Melissa','Melvin','Mia','Michael','Michelle','Miguel','Mike','Mildred','Miranda',
  'Mitchell','Molly','Monica','Morgan','Nancy','Naomi','Natalie','Natasha','Nathan','Nathaniel',
  'Neil','Nelson','Nicholas','Nicole','Nina','Noah','Nora','Norma','Norman','Olga',
  'Olivia','Oscar','Owen','Pablo','Pamela','Patricia','Patrick','Paul','Paula','Pedro',
  'Penny','Pete','Peter','Philip','Phillip','Phyllis','Preston','Priscilla','Rachel','Ralph',
  'Randall','Randy','Raul','Raymond','Rebecca','Regina','Renee','Reuben','Rhonda','Ricardo',
  'Richard','Rick','Ricky','Robert','Roberto','Robin','Rodney','Roger','Roland','Ron',
  'Ronald','Ronnie','Rosa','Rose','Roy','Ruby','Russell','Ruth','Ryan','Sabrina',
  'Sally','Samantha','Samuel','Sandra','Sara','Sarah','Saul','Scott','Sean','Sebastian',
  'Serena','Sergio','Seth','Shane','Shannon','Sharon','Shawn','Shelby','Sheri','Sherri',
  'Sherry','Shirley','Sidney','Sierra','Simon','Sofia','Sophia','Stacey','Stacy','Stanley',
  'Stella','Stephanie','Stephen','Steve','Steven','Sue','Susan','Suzanne','Sydney','Sylvia',
  'Tamara','Tammy','Tanya','Tara','Taylor','Ted','Teresa','Terri','Terry','Theodore',
  'Theresa','Thomas','Tiffany','Tim','Timothy','Tina','Todd','Tom','Tommy','Tony',
  'Tracy','Travis','Trevor','Tristan','Troy','Tyler','Valerie','Vanessa','Vera','Veronica',
  'Vicki','Vicky','Victor','Victoria','Vincent','Violet','Virginia','Wade','Walter','Wanda',
  'Warren','Wayne','Wendy','Wesley','William','Willie','Wyatt','Xavier','Yolanda','Yvonne',
  'Zachary','Zoe','Zoey'
]));

export const LAST_NAMES = Object.freeze(new Set([
  // top-frequency US surnames (US Census 2010 public-domain, alphabetized)
  'Adams','Aguilar','Alexander','Allen','Alvarado','Alvarez','Anderson','Andrews','Armstrong','Arnold',
  'Bailey','Baker','Banks','Barnes','Bates','Bauer','Becker','Bell','Bennett','Berry',
  'Black','Blair','Bowman','Boyd','Bradley','Brewer','Briggs','Brooks','Brown','Bryant',
  'Burgess','Burke','Burns','Burton','Butler','Byrd','Caldwell','Cameron','Campbell','Cannon',
  'Carlson','Carpenter','Carr','Carroll','Carter','Castillo','Castro','Chan','Chang','Chapman',
  'Chavez','Chen','Cho','Choi','Christensen','Clark','Clarke','Cohen','Cole','Coleman',
  'Collins','Cook','Cooper','Cortez','Cox','Craig','Crawford','Cruz','Cunningham','Curtis',
  'Daniels','Davidson','Davis','Dawson','Day','Dean','Delgado','Diaz','Dixon','Dominguez',
  'Donovan','Douglas','Doyle','Duncan','Dunn','Duong','Edwards','Elliott','Ellis','Erickson',
  'Espinoza','Estrada','Evans','Farmer','Faulkner','Ferguson','Fernandez','Fields','Figueroa','Fischer',
  'Fisher','Fitzgerald','Flores','Floyd','Ford','Foster','Fowler','Fox','Francis','Franklin',
  'Frazier','Freeman','French','Fuller','Gagnon','Gallagher','Garcia','Gardner','Garrett','George',
  'Gibson','Gilbert','Gomez','Gonzales','Gonzalez','Goodman','Gordon','Graham','Grant','Graves',
  'Gray','Green','Greene','Gregory','Griffin','Griffith','Grimes','Gross','Guerrero','Gutierrez',
  'Hahn','Hale','Hall','Hamilton','Hammond','Hansen','Hanson','Hardy','Harmon','Harper',
  'Harrington','Harris','Harrison','Hart','Hartman','Harvey','Hayes','Henderson','Henry','Hernandez',
  'Herrera','Hicks','Higgins','Hill','Hines','Ho','Hoang','Hobbs','Hodges','Hoffman',
  'Holland','Holloway','Holmes','Holt','Hood','Hoover','Hopkins','Horton','Howard','Howell',
  'Hu','Huang','Hubbard','Huber','Hudson','Huff','Huffman','Hughes','Hunt','Hunter',
  'Hurley','Hutchinson','Ingram','Jackson','Jacobs','Jacobson','James','Jenkins','Jennings','Jensen',
  'Jimenez','Johnson','Johnston','Jones','Jordan','Joseph','Joyce','Kane','Keller','Kelley',
  'Kelly','Kennedy','Kent','Khan','Kim','King','Kirby','Klein','Knight','Knox',
  'Koch','Kramer','Krause','Krueger','Lam','Lambert','Lane','Lara','Larsen','Larson',
  'Lawrence','Lawson','Le','Leach','Leblanc','Lee','Lemon','Leon','Leonard','Leung',
  'Levin','Levine','Lewis','Li','Liang','Lim','Lin','Lindsey','Liu','Logan',
  'Long','Lopez','Lowe','Lozano','Lucas','Luna','Lynch','Lyons','MacDonald','Macias',
  'Madden','Maddox','Mahoney','Malone','Mann','Manning','Marks','Marshall','Martin','Martinez',
  'Mason','Mata','Mathis','Matthews','Maxwell','May','Mayer','Maynard','Mays','McBride',
  'McCarthy','McConnell','McCoy','McDaniel','McDonald','McGee','McGrath','McGuire','McKenzie','McKinney',
  'McLaughlin','McMahon','McMillan','McNeil','McPherson','Medina','Mejia','Melendez','Melton','Mendez',
  'Mendoza','Mercer','Merritt','Meyer','Meyers','Michael','Middleton','Miles','Miller','Mills',
  'Miranda','Mitchell','Molina','Monroe','Montgomery','Montoya','Moody','Moon','Mooney','Moore',
  'Morales','Moran','Moreno','Morgan','Morris','Morrison','Morton','Moss','Moyer','Mullen',
  'Mullins','Munoz','Murillo','Murphy','Murray','Myers','Nash','Navarro','Neal','Nelson',
  'Newman','Newton','Ng','Nguyen','Nichols','Nicholson','Nielsen','Nixon','Nolan','Noble',
  'Norman','Norris','Norton','Nunez','O’Brien','O’Connor','O’Donnell','Obrien','Ochoa','Odom',
  'Oliver','Olsen','Olson','Ortega','Ortiz','Osborne','Owen','Owens','Pace','Pacheco',
  'Padilla','Page','Palmer','Park','Parker','Parks','Parsons','Patel','Patterson','Patton',
  'Paul','Payne','Pearson','Peck','Pena','Pennington','Perez','Perkins','Perry','Peters',
  'Petersen','Peterson','Pham','Phan','Phelps','Phillips','Pierce','Pittman','Pitts','Pollard',
  'Pope','Porter','Potter','Powell','Powers','Pratt','Preston','Price','Prince','Pruitt',
  'Pugh','Quinn','Ramirez','Ramos','Ramsey','Randall','Randolph','Rangel','Rasmussen','Ray',
  'Reed','Reese','Reeves','Reid','Reilly','Reyes','Reynolds','Rhodes','Rice','Rich',
  'Richards','Richardson','Riddle','Riley','Rios','Rivera','Rivers','Roberson','Roberts','Robertson',
  'Robinson','Robles','Rodgers','Rodriguez','Rogers','Rojas','Rollins','Roman','Romero','Rosales',
  'Rose','Ross','Rowe','Roy','Rubio','Ruiz','Russell','Russo','Ryan','Salas',
  'Salazar','Salinas','Sampson','Sanchez','Sanders','Sandoval','Santana','Santiago','Santos','Saunders',
  'Savage','Schaefer','Schmidt','Schneider','Schroeder','Schultz','Schwartz','Scott','Sellers','Serrano',
  'Sexton','Shaffer','Shah','Shannon','Sharma','Sharp','Shaw','Sheppard','Sherman','Shields',
  'Shin','Short','Silva','Simmons','Simon','Simpson','Sims','Singh','Skinner','Slater',
  'Sloan','Small','Smith','Snow','Snyder','Solis','Solomon','Sosa','Soto','Sparks',
  'Spears','Spence','Spencer','Stafford','Stanley','Stanton','Stark','Steele','Stein','Stephens',
  'Stevens','Stevenson','Stewart','Stokes','Stone','Stout','Strickland','Strong','Stuart','Suarez',
  'Sullivan','Summers','Sutton','Swanson','Sweeney','Tan','Tang','Tanner','Tate','Taylor',
  'Terry','Thomas','Thompson','Thornton','Tian','Tillman','Todd','Torres','Tran','Travis',
  'Trujillo','Truong','Tucker','Turner','Tyler','Underwood','Valdez','Valencia','Valentine','Vance',
  'Vang','Vargas','Vasquez','Vaughan','Vaughn','Vazquez','Vega','Velasquez','Velazquez','Vincent',
  'Vo','Vu','Wade','Wagner','Walker','Wall','Wallace','Walls','Walsh','Walter',
  'Walters','Walton','Wang','Ward','Ware','Warner','Warren','Washington','Waters','Watkins',
  'Watson','Watts','Weaver','Webb','Weber','Webster','Weiss','Welch','Wells','West',
  'Wheeler','Whitaker','White','Whitehead','Whitfield','Whitley','Whitney','Wiggins','Wilcox','Wiley',
  'Wilkerson','Wilkins','Wilkinson','Williams','Williamson','Willis','Wilson','Winters','Wise','Wolf',
  'Wolfe','Wong','Woo','Wood','Woodard','Woods','Woodward','Workman','Wright','Wu',
  'Wyatt','Xie','Xiong','Xu','Yamamoto','Yang','Yates','Ye','Yeh','Yi',
  'Yoder','York','Young','Yu','Yuan','Zamora','Zavala','Zhang','Zhao','Zhou',
  'Zhu','Zimmerman','Zuniga'
]));

// Backward-compatible aliases requested by the API in the task brief.
export const TOP_1000_FIRST_NAMES = FIRST_NAMES;
export const TOP_1000_LAST_NAMES = LAST_NAMES;
